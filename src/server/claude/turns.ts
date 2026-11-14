import 'server-only';
import { randomUUID } from 'node:crypto';
import { logActivity } from '@/server/activity';
import { withUser, type Tx } from '@/server/db/withUser';
import type { ConversationMode, MessageStatus } from '@/server/db/types';
import type { ResourceRef } from '@/lib/types';
import { buildHistory, conversationTitle, type HistoryMessage, type HistoryRow } from './history';

/**
 * Persistence for one chat turn (a user message and its assistant reply).
 *
 * Idempotency: the browser sends a clientRequestId (uuid) per prompt and resends the SAME id on
 * Retry. The user message stores it in messages.client_request_id; its reply stores
 * `<clientRequestId>:assistant`, which is how a reply is found from its prompt (both unique per
 * conversation). A repeated id never inserts a second user message:
 *   - reply complete           → replay the stored reply (Claude is not called again);
 *   - reply still streaming    → wait for the running request to finish, then replay it;
 *   - reply error / stale / gone → claim the reply row again (status back to 'streaming') and
 *     re-run Claude for the stored prompt and refs (the request's text is ignored).
 * Lookups are scoped to the session, so a resend without the conversation id (the browser never
 * saw it) still finds the turn. A transaction-scoped advisory lock on the id serializes duplicates.
 *
 * Attempts: every run owns a random `attempt` id stored in the reply's usage jsonb while it
 * streams. Every later write is conditional on that id, so a superseded or stopped run can never
 * overwrite a newer attempt.
 */

export const ASSISTANT_SUFFIX = ':assistant';
/** A 'streaming' reply not written to for this long is treated as failed (its server run died). */
export const STALE_STREAMING_SECONDS = 90;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TurnErrorCode = 'not_found' | 'read_only' | 'invalid';

/** The turn cannot start. Nothing was written. Messages are user-facing. */
export class TurnError extends Error {
  readonly name = 'TurnError';
  constructor(readonly code: TurnErrorCode, message: string) {
    super(message);
  }
}

export type TurnInput = {
  userId: string;
  sessionId: string;
  conversationId?: string | null;
  text: string;
  refs: ResourceRef[];
  mode: ConversationMode;
  clientRequestId: string;
};

type Ids = { conversationId: string; userMessageId: string; assistantMessageId: string };
export type Usage = { input_tokens: number; output_tokens: number };

export type PreparedTurn =
  | (Ids & { kind: 'replay'; content: string; usage: Usage | null; model: string | null })
  | (Ids & { kind: 'wait' })
  | (Ids & { kind: 'run'; attempt: string; sessionId: string; text: string; refs: ResourceRef[]; history: HistoryMessage[] });

async function historyBefore(tx: Tx, conversationId: string, userMessageId: string): Promise<HistoryMessage[]> {
  const rows = await tx<HistoryRow[]>`
    select role, content, status from public.messages
    where conversation_id = ${conversationId}
      and created_at < (select created_at from public.messages where id = ${userMessageId})
    order by created_at, id`;
  return buildHistory(rows);
}

/**
 * Validates the session/conversation and records the turn, in one transaction that commits before
 * Claude is called (so the prompt is saved even if everything after fails).
 */
export function prepareTurn(input: TurnInput): Promise<PreparedTurn> {
  const { sessionId, clientRequestId: crid } = input;
  if (!UUID_RE.test(sessionId)) return Promise.reject(new TurnError('not_found', 'This session no longer exists.'));
  if (!UUID_RE.test(crid)) return Promise.reject(new TurnError('invalid', 'Invalid request id.'));
  if (input.conversationId != null && !UUID_RE.test(input.conversationId)) {
    return Promise.reject(new TurnError('not_found', 'This conversation no longer exists.'));
  }

  return withUser(input.userId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`claude-turn:${crid}`}, 0))`;

    const [session] = await tx<{ status: 'active' | 'completed' }[]>`select status from public.sessions where id = ${sessionId}`;
    if (!session) throw new TurnError('not_found', 'This session no longer exists.');
    if (session.status === 'completed') throw new TurnError('read_only', 'This session is completed and read-only.');

    const [prior] = await tx<{ id: string; conversation_id: string; content: string; refs: ResourceRef[] }[]>`
      select m.id, m.conversation_id, m.content, m.refs
      from public.messages m join public.conversations c on c.id = m.conversation_id
      where c.session_id = ${sessionId} and m.role = 'user' and m.client_request_id = ${crid}`;

    if (prior) {
      const conversationId = prior.conversation_id;
      const [reply] = await tx<{ id: string; status: MessageStatus; content: string; usage: Usage | null; model: string | null; stale: boolean }[]>`
        select id, status, content, usage, model,
               updated_at < now() - make_interval(secs => ${STALE_STREAMING_SECONDS}) as stale
        from public.messages
        where conversation_id = ${conversationId} and client_request_id = ${crid + ASSISTANT_SUFFIX}`;
      const ids = { conversationId, userMessageId: prior.id };
      if (reply?.status === 'complete') {
        return { kind: 'replay', ...ids, assistantMessageId: reply.id, content: reply.content, usage: reply.usage, model: reply.model };
      }
      if (reply?.status === 'streaming' && !reply.stale) return { kind: 'wait', ...ids, assistantMessageId: reply.id };

      // Errored, abandoned or missing reply: re-run Claude for the stored prompt.
      const attempt = randomUUID();
      let assistantMessageId: string;
      if (reply) {
        await tx`
          update public.messages
          set status = 'streaming', content = '', model = null, usage = ${tx.json({ attempt })}
          where id = ${reply.id}`;
        assistantMessageId = reply.id;
      } else {
        const [row] = await tx<{ id: string }[]>`
          insert into public.messages (conversation_id, role, content, status, client_request_id, usage, created_at)
          values (${conversationId}, 'assistant', '', 'streaming', ${crid + ASSISTANT_SUFFIX}, ${tx.json({ attempt })}, clock_timestamp())
          returning id`;
        assistantMessageId = row.id;
      }
      await logActivity(tx, {
        action: 'claude.message.retry',
        entityType: 'message',
        entityId: prior.id,
        sessionId,
        meta: { conversationId },
      });
      return {
        kind: 'run',
        ...ids,
        assistantMessageId,
        attempt,
        sessionId,
        text: prior.content,
        refs: prior.refs,
        history: await historyBefore(tx, conversationId, prior.id),
      };
    }

    let conversationId: string;
    if (input.conversationId) {
      const [conv] = await tx<{ id: string }[]>`
        select id from public.conversations where id = ${input.conversationId} and session_id = ${sessionId}`;
      if (!conv) throw new TurnError('not_found', 'This conversation no longer exists.');
      conversationId = conv.id;
      await tx`update public.conversations set title = coalesce(title, ${conversationTitle(input.text)}) where id = ${conversationId}`;
    } else {
      const [conv] = await tx<{ id: string }[]>`
        insert into public.conversations (session_id, mode, title)
        values (${sessionId}, ${input.mode}, ${conversationTitle(input.text)})
        returning id`;
      conversationId = conv.id;
      await logActivity(tx, { action: 'conversation.create', entityType: 'conversation', entityId: conversationId, sessionId, meta: { mode: input.mode } });
    }

    // clock_timestamp(): strictly increasing within the transaction, so the prompt sorts before its reply.
    const [user] = await tx<{ id: string }[]>`
      insert into public.messages (conversation_id, role, content, refs, status, client_request_id, created_at)
      values (${conversationId}, 'user', ${input.text}, ${tx.json(input.refs as never)}, 'complete', ${crid}, clock_timestamp())
      returning id`;
    const attempt = randomUUID();
    const [assistant] = await tx<{ id: string }[]>`
      insert into public.messages (conversation_id, role, content, status, client_request_id, usage, created_at)
      values (${conversationId}, 'assistant', '', 'streaming', ${crid + ASSISTANT_SUFFIX}, ${tx.json({ attempt })}, clock_timestamp())
      returning id`;
    await tx`update public.conversations set updated_at = now() where id = ${conversationId}`;
    await logActivity(tx, {
      action: 'claude.message.send',
      entityType: 'message',
      entityId: user.id,
      sessionId,
      meta: { conversationId, refCount: input.refs.length },
    });

    return {
      kind: 'run',
      conversationId,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      attempt,
      sessionId,
      text: input.text,
      refs: input.refs,
      history: await historyBefore(tx, conversationId, user.id),
    };
  });
}

/**
 * Writes for one run, serialized and conditional on the run's attempt id. `flush` saves partial
 * text (and doubles as a heartbeat); it resolves false once the reply is no longer this run's
 * streaming reply (stopped by the user, retried elsewhere, or deleted), which tells the run to stop.
 */
export class ReplyWriter {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly userId: string,
    private readonly messageId: string,
    private readonly attempt: string,
  ) {}

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  flush(content: string): Promise<boolean> {
    return this.queue(() =>
      withUser(this.userId, async (tx) => {
        const rows = await tx`
          update public.messages set content = ${content}
          where id = ${this.messageId} and status = 'streaming' and usage ->> 'attempt' = ${this.attempt}
          returning id`;
        return rows.length > 0;
      }),
    );
  }

  /** Marks the reply complete. False when it was stopped/superseded meanwhile (nothing written). */
  complete(content: string, usage: Usage, model: string): Promise<boolean> {
    return this.queue(() =>
      withUser(this.userId, async (tx) => {
        const rows = await tx`
          update public.messages
          set status = 'complete', content = ${content}, model = ${model}, usage = ${tx.json(usage)}
          where id = ${this.messageId} and status = 'streaming' and usage ->> 'attempt' = ${this.attempt}
          returning id`;
        return rows.length > 0;
      }),
    );
  }

  /** Marks the reply 'error', keeping whatever text arrived (also after a user stop). */
  fail(content: string, code: string): Promise<void> {
    return this.queue(() =>
      withUser(this.userId, async (tx) => {
        await tx`
          update public.messages
          set status = 'error', content = ${content},
              usage = coalesce(usage, '{}'::jsonb) || ${tx.json({ error: code })}
          where id = ${this.messageId} and status in ('streaming', 'error') and usage ->> 'attempt' = ${this.attempt}`;
      }),
    );
  }

  settled(): Promise<unknown> {
    return this.chain;
  }
}

/** The current state of a reply (for waiting on a run in another request). */
export async function readReply(userId: string, messageId: string) {
  const [row] = await withUser(userId, (tx) => tx<{ status: MessageStatus; content: string; usage: Usage | null; model: string | null; stale: boolean }[]>`
    select status, content, usage, model, updated_at < now() - make_interval(secs => ${STALE_STREAMING_SECONDS}) as stale
    from public.messages where id = ${messageId}`);
  return row ?? null;
}

/**
 * User pressed Stop: marks the user's streaming reply 'error' (stopped). The run notices on its next
 * flush, aborts the upstream request and saves the partial text. False when there was nothing to stop.
 */
export async function stopReplyFor(userId: string, messageId: string): Promise<boolean> {
  if (!UUID_RE.test(messageId)) return false;
  return withUser(userId, async (tx) => {
    const [row] = await tx<{ conversation_id: string }[]>`
      update public.messages
      set status = 'error', usage = coalesce(usage, '{}'::jsonb) || '{"stopped": true}'::jsonb
      where id = ${messageId} and role = 'assistant' and status = 'streaming'
      returning conversation_id`;
    if (!row) return false;
    const [conv] = await tx<{ session_id: string }[]>`select session_id from public.conversations where id = ${row.conversation_id}`;
    await logActivity(tx, {
      action: 'claude.message.stop',
      entityType: 'message',
      entityId: messageId,
      sessionId: conv?.session_id,
      meta: { conversationId: row.conversation_id },
    });
    return true;
  });
}
