import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { encodeSseEvent, SSE_PING } from '@/lib/sse';
import type { ResourceRef } from '@/lib/types';
import type { ConversationMode } from '@/server/db/types';
import type { ClaudeStreamEvents } from '@/features/claude/types';
import { KeyEncryptionConfigError } from '@/server/security/crypto';
import { buildContext, ForbiddenError } from './context';
import type { HistoryMessage } from './history';
import { ClaudeKeyMissingError, ClaudeKeyUnreadableError, resolveClaudeKeyFor } from './keys';
import { prepareTurn, readReply, ReplyWriter, tokenUsageOf, trimmedOf, TurnError, type PreparedTurn, type Usage } from './turns';

/**
 * The Claude gateway: the only module that imports the Anthropic SDK (server-only).
 *
 * Keys: the user's decrypted key if saved, else ANTHROPIC_API_KEY (keys.ts). The key goes from
 * there into the SDK client and nowhere else: it is never logged, returned, or put in an error
 * message (upstream error text is scrubbed and mostly replaced by fixed messages).
 *
 * Streaming chat (streamClaude): the prompt and an empty 'streaming' reply are committed BEFORE
 * Claude is called; deltas are forwarded as SSE and saved about once a second; the reply ends
 * 'complete' (content, usage, model) or 'error' with whatever partial text arrived. The user
 * message always stays 'complete'.
 *
 * Client disconnect (tab closed, network drop, or the browser aborting its fetch): the run does NOT
 * abort. It keeps consuming the upstream stream to the end and persists the full reply, so a closed
 * tab never loses an answer (the route keeps the function alive with `after`). The explicit Stop
 * button is different: it marks the reply stopped in the database (stopReplyFor), the run notices
 * on its next save, aborts the upstream request and keeps the partial text as an 'error' reply that
 * can be retried.
 */

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
/** Token budget (4 characters per token) for the documents sent with one message. */
export const DEFAULT_CONTEXT_TOKENS = 60_000;
const FLUSH_MS = 1000;
const KEEPALIVE_MS = 15_000;
const WAIT_POLL_MS = 1000;
const WAIT_MAX_MS = 270_000;

export function resolveModel(profileModel: string | null | undefined, env: Record<string, string | undefined> = process.env): string {
  return profileModel?.trim() || env.CLAUDE_MODEL?.trim() || DEFAULT_MODEL;
}

const numberEnv = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// ------------------------------------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------------------------------------

export type ClaudeErrorCode =
  | 'auth'
  | 'permission'
  | 'invalid_request'
  | 'too_large'
  | 'rate_limited'
  | 'overloaded'
  | 'server'
  | 'timeout'
  | 'connection'
  | 'stopped'
  | 'upstream';

/** A failed upstream call. `message` is fixed, user-facing text (never raw upstream text with secrets). */
export class ClaudeUpstreamError extends Error {
  readonly name = 'ClaudeUpstreamError';
  constructor(
    readonly code: ClaudeErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

const ANTHROPIC_KEY_RE = /sk-ant-[A-Za-z0-9_-]+/g;

/** Removes the given secrets and anything shaped like an Anthropic key from `text`. */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  return out.replace(ANTHROPIC_KEY_RE, '[redacted]');
}

function upstreamDetail(e: InstanceType<typeof Anthropic.APIError>, secrets: readonly string[]): string {
  const raw = (e.apiMessage ?? '').trim();
  if (!raw) return '';
  const clean = scrubSecrets(raw, secrets).slice(0, 300);
  return `: ${clean}`;
}

/** Classifies any failure of an upstream call into a ClaudeUpstreamError (scrubbed, user-facing). */
export function toUpstreamError(e: unknown, secrets: readonly string[]): ClaudeUpstreamError {
  if (e instanceof ClaudeUpstreamError) return e;
  if (e instanceof Anthropic.APIUserAbortError) return new ClaudeUpstreamError('stopped', 'Stopped.', true);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ClaudeUpstreamError('timeout', 'Claude took too long to respond. Retry in a moment.', true);
  if (e instanceof Anthropic.APIConnectionError) return new ClaudeUpstreamError('connection', 'Could not reach Claude. Check the connection and retry.', true);
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === 'number' ? e.status : undefined;
    const type: string = e.type ?? '';
    if (status === 401 || type === 'authentication_error') return new ClaudeUpstreamError('auth', 'Claude rejected the API key. Check it in Settings.', false, status);
    if (status === 403 || type === 'permission_error') return new ClaudeUpstreamError('permission', 'This API key is not allowed to make this Claude request.', false, status);
    if (status === 413 || type === 'request_too_large') {
      return new ClaudeUpstreamError('too_large', 'This conversation is too long for Claude. Start a new conversation or select fewer items.', false, status);
    }
    if (status === 429 || type === 'rate_limit_error') return new ClaudeUpstreamError('rate_limited', 'Claude is rate-limiting requests. Wait a moment, then retry.', true, status);
    if (status === 529 || type === 'overloaded_error') return new ClaudeUpstreamError('overloaded', 'Claude is overloaded right now. Retry in a moment.', true, status);
    if (status === 400 || status === 404 || type === 'invalid_request_error' || type === 'not_found_error') {
      return new ClaudeUpstreamError('invalid_request', `Claude rejected the request${upstreamDetail(e, secrets)}`, false, status);
    }
    if ((status !== undefined && status >= 500) || type === 'api_error') return new ClaudeUpstreamError('server', 'Claude had a server error. Retry in a moment.', true, status);
    return new ClaudeUpstreamError('upstream', 'Claude returned an error. Retry in a moment.', true, status);
  }
  // Socket closed mid-stream, DNS failure, etc.
  return new ClaudeUpstreamError('connection', 'The connection to Claude was interrupted. Retry to try again.', true);
}

// ------------------------------------------------------------------------------------------------
// Upstream call
// ------------------------------------------------------------------------------------------------

export type ApiMessage = { role: 'user' | 'assistant'; content: string | { type: 'text'; text: string }[] };
export type UpstreamResult = { model: string; usage: Usage; stopReason: string | null };

function anthropicClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    authToken: null, // never also send an ANTHROPIC_AUTH_TOKEN from the environment
    baseURL: process.env.ANTHROPIC_BASE_URL?.trim() || undefined,
    maxRetries: numberEnv('CLAUDE_MAX_RETRIES', 2),
    timeout: 270_000, // below the route's maxDuration (300 s)
    logLevel: 'off', // the SDK's own logging could include request details
  });
}

/**
 * Streams one Messages API call: yields text deltas, returns usage/model/stop reason. Throws
 * ClaudeUpstreamError (scrubbed) on any failure, including a stream that ends without
 * message_stop, and a 'stopped' error when `signal` aborts it.
 */
export async function* streamUpstream(p: {
  apiKey: string;
  model: string;
  system: string;
  messages: ApiMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}): AsyncGenerator<{ text: string }, UpstreamResult> {
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let model = p.model;
  let stopReason: string | null = null;
  let finished = false;
  try {
    const stream = await anthropicClient(p.apiKey).messages.create(
      { model: p.model, max_tokens: p.maxTokens, system: p.system, messages: p.messages, stream: true },
      { signal: p.signal },
    );
    for await (const ev of stream) {
      if (ev.type === 'message_start') {
        model = ev.message.model || model;
        usage.input_tokens = ev.message.usage?.input_tokens ?? 0;
        usage.output_tokens = ev.message.usage?.output_tokens ?? 0;
      } else if (ev.type === 'content_block_delta') {
        if (ev.delta.type === 'text_delta' && ev.delta.text) yield { text: ev.delta.text };
      } else if (ev.type === 'message_delta') {
        usage.output_tokens = ev.usage?.output_tokens ?? usage.output_tokens;
        if (typeof ev.usage?.input_tokens === 'number') usage.input_tokens = ev.usage.input_tokens;
        stopReason = ev.delta?.stop_reason ?? stopReason;
      } else if (ev.type === 'message_stop') {
        finished = true;
      }
    }
  } catch (e) {
    if (p.signal?.aborted) throw new ClaudeUpstreamError('stopped', 'Stopped.', true);
    throw toUpstreamError(e, [p.apiKey]);
  }
  if (p.signal?.aborted) throw new ClaudeUpstreamError('stopped', 'Stopped.', true);
  if (!finished) throw new ClaudeUpstreamError('connection', 'The connection to Claude closed before the reply finished. Retry to try again.', true);
  return { model, usage, stopReason };
}

/** Prior turns + the current prompt (documents first), merging into a trailing user turn if needed. */
export function toApiMessages(history: readonly HistoryMessage[], documents: string, text: string): ApiMessage[] {
  const blocks: { type: 'text'; text: string }[] = [...(documents ? [{ type: 'text' as const, text: documents }] : []), { type: 'text', text }];
  const out: ApiMessage[] = history.map((m) => ({ role: m.role, content: m.content }));
  const last = out.at(-1);
  if (last?.role === 'user') {
    const prev = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content;
    out[out.length - 1] = { role: 'user', content: [...prev, ...blocks] };
  } else {
    out.push({ role: 'user', content: blocks.length === 1 ? text : blocks });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Streaming chat turn
// ------------------------------------------------------------------------------------------------

export type StreamClaudeInput = {
  userId: string;
  sessionId: string;
  /** Omit for a new conversation: one is created (mode `mode`) with the first message. */
  conversationId?: string | null;
  text: string;
  refs: ResourceRef[];
  mode: ConversationMode;
  clientRequestId: string;
};

export type { ClaudeStreamEvents };
type Emit = <K extends keyof ClaudeStreamEvents>(event: K, data: ClaudeStreamEvents[K]) => void;

type ClientError = { message: string; retryable: boolean; code: string };

function clientError(e: unknown): ClientError {
  if (e instanceof ClaudeUpstreamError) return { message: e.message, retryable: e.retryable, code: e.code };
  if (e instanceof ForbiddenError) return { message: e.message, retryable: false, code: 'forbidden' };
  if (e instanceof TurnError) return { message: e.message, retryable: false, code: e.code };
  if (e instanceof ClaudeKeyMissingError || e instanceof ClaudeKeyUnreadableError) return { message: e.message, retryable: true, code: e.code };
  if (e instanceof KeyEncryptionConfigError) {
    console.error('[claude] KEY_ENCRYPTION_SECRET is not configured; saved Claude keys cannot be used.');
    return { message: 'Claude key storage is not configured on this server. Ask the administrator to set KEY_ENCRYPTION_SECRET.', retryable: false, code: 'key_config' };
  }
  console.error('[claude] turn failed:', e instanceof Error ? `${e.name}: ${scrubSecrets(e.message)}` : 'unknown error');
  return { message: 'Something went wrong. Retry in a moment.', retryable: true, code: 'internal' };
}

const STOPPED: ClientError = { message: 'Stopped.', retryable: true, code: 'stopped' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Another request is streaming this reply: wait for it to finish, then replay its result. */
async function waitForReply(userId: string, turn: Extract<PreparedTurn, { kind: 'wait' }>, emit: Emit) {
  const deadline = Date.now() + WAIT_MAX_MS;
  while (Date.now() < deadline) {
    const row = await readReply(userId, turn.assistantMessageId);
    if (!row) break;
    if (row.status === 'complete') {
      if (row.content) emit('delta', { text: row.content });
      emit('done', { messageId: turn.assistantMessageId, conversationId: turn.conversationId, usage: tokenUsageOf(row.usage), model: row.model, trimmed: trimmedOf(row.usage) });
      return;
    }
    if (row.status === 'error' || row.stale) break;
    await sleep(WAIT_POLL_MS);
  }
  emit('error', { message: 'This reply did not finish. Retry to try again.', retryable: true, code: 'interrupted', messageId: turn.assistantMessageId });
}

async function runTurn(input: StreamClaudeInput, emit: Emit): Promise<void> {
  let turn: PreparedTurn;
  try {
    turn = await prepareTurn(input);
  } catch (e) {
    emit('error', clientError(e));
    return;
  }
  const { conversationId, userMessageId, assistantMessageId } = turn;
  emit('start', { conversationId, userMessageId, assistantMessageId, replay: turn.kind !== 'run' });

  if (turn.kind === 'replay') {
    if (turn.content) emit('delta', { text: turn.content });
    emit('done', { messageId: assistantMessageId, conversationId, usage: tokenUsageOf(turn.usage), model: turn.model, trimmed: trimmedOf(turn.usage) });
    return;
  }
  if (turn.kind === 'wait') return waitForReply(input.userId, turn, emit);

  const writer = new ReplyWriter(input.userId, assistantMessageId, turn.attempt);
  const abort = new AbortController();
  let text = '';
  let stopped = false;
  let flushing = false;
  const timer = setInterval(() => {
    if (flushing) return;
    flushing = true;
    writer
      .flush(text)
      .then((ours) => {
        if (!ours && !stopped) {
          stopped = true;
          abort.abort();
        }
      })
      .catch(() => undefined) // a failed partial save is retried on the next tick
      .finally(() => {
        flushing = false;
      });
  }, FLUSH_MS);

  try {
    const { apiKey, profileModel } = await resolveClaudeKeyFor(input.userId);
    const ctx = await buildContext({ userId: input.userId, sessionId: turn.sessionId, refs: turn.refs, budgetTokens: numberEnv('CLAUDE_CONTEXT_TOKENS', DEFAULT_CONTEXT_TOKENS) });
    const gen = streamUpstream({
      apiKey,
      model: resolveModel(profileModel),
      system: ctx.system,
      messages: toApiMessages(turn.history, ctx.documents, turn.text),
      maxTokens: numberEnv('CLAUDE_MAX_TOKENS', 8192),
      signal: abort.signal,
    });
    let result: UpstreamResult;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
      text += next.value.text;
      emit('delta', { text: next.value.text });
    }
    clearInterval(timer);
    if (await writer.complete(text, result.usage, result.model, ctx.trimmed)) {
      emit('done', { messageId: assistantMessageId, conversationId, usage: result.usage, model: result.model, trimmed: ctx.trimmed });
    } else {
      // Stopped (or superseded) between the last delta and completion: keep the text, report stopped.
      await writer.fail(text, 'stopped');
      emit('error', { ...STOPPED, messageId: assistantMessageId });
    }
  } catch (e) {
    clearInterval(timer);
    const err = stopped ? STOPPED : clientError(e);
    if (e instanceof ClaudeUpstreamError && !stopped) {
      console.warn(`[claude] upstream error code=${e.code} status=${e.status ?? '-'}`);
    }
    try {
      await writer.fail(text, err.code);
    } catch (writeError) {
      // e.g. the session was completed meanwhile (its messages are read-only now).
      console.error('[claude] could not record the failed reply:', writeError instanceof Error ? writeError.name : 'unknown');
    }
    emit('error', { ...err, messageId: assistantMessageId });
  } finally {
    clearInterval(timer);
    await writer.settled();
  }
}

/**
 * Runs one chat turn and returns its SSE stream (events: start, delta, done, error; see
 * ClaudeStreamEvents). `waitUntil` receives the background task, which outlives the stream when the
 * client disconnects (route: next/server `after`; tests: await it).
 */
export function streamClaude(input: StreamClaudeInput, opts: { waitUntil?: (task: Promise<unknown>) => void } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let open = true;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          open = false;
        }
      };
      const emit: Emit = (event, data) => write(encodeSseEvent(event, data));
      const keepAlive = setInterval(() => write(SSE_PING), KEEPALIVE_MS);
      const task = runTurn(input, emit)
        .catch((e: unknown) => emit('error', clientError(e)))
        .finally(() => {
          clearInterval(keepAlive);
          if (open) {
            open = false;
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        });
      opts.waitUntil?.(task);
    },
    cancel() {
      // The client went away. Keep running: the reply is persisted to completion.
      open = false;
    },
  });
}
