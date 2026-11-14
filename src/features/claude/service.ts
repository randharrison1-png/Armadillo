import 'server-only';
import { withUser } from '@/server/db/withUser';
import { hasUsableKeyFor } from '@/server/claude/keys';
import { ASSISTANT_SUFFIX, STALE_STREAMING_SECONDS } from '@/server/claude/turns';
import { STEP_LABEL } from '@/features/flowchart/stepMeta';
import type { ConversationMode, EvidenceKind, MessageRole, MessageStatus } from '@/server/db/types';
import type { ResourceRef, StepKey } from '@/lib/types';
import type { ChatMessage, ClaudeTabData, ContextOptions, ConversationSummary } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGES = 500;

const dateLabel = (d: Date) => `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(d)} UTC`;
const basename = (p: string | null) => (p ? p.slice(p.lastIndexOf('/') + 1).replace(/^[0-9a-f-]{36}-/i, '') : null);

type ConvRow = { id: string; mode: ConversationMode; title: string | null; updated_at: Date };
const toSummary = (c: ConvRow): ConversationSummary => ({ id: c.id, mode: c.mode, title: c.title, updatedAt: c.updated_at.toISOString() });

/** Conversations (newest first), session status and whether a key is available. Null if not the user's session. */
export function getClaudeTabFor(userId: string, sessionId: string): Promise<ClaudeTabData | null> {
  if (!UUID_RE.test(sessionId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const [session] = await tx<{ status: 'active' | 'completed' }[]>`select status from public.sessions where id = ${sessionId}`;
    if (!session) return null;
    const convs = await tx<ConvRow[]>`
      select id, mode, title, updated_at from public.conversations
      where session_id = ${sessionId} order by updated_at desc, created_at desc`;
    return { sessionStatus: session.status, conversations: convs.map(toSummary), keyConfigured: await hasUsableKeyFor(tx) };
  });
}

type MessageRow = {
  id: string;
  role: MessageRole;
  content: string;
  refs: ResourceRef[];
  status: MessageStatus;
  client_request_id: string | null;
  created_at: Date;
  usage: Record<string, unknown> | null;
  stale: boolean;
};

/** A conversation's messages, oldest first. Abandoned 'streaming' replies are shown as failed. */
export function getConversationFor(userId: string, conversationId: string): Promise<{ conversation: ConversationSummary; messages: ChatMessage[] } | null> {
  if (!UUID_RE.test(conversationId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const [conv] = await tx<ConvRow[]>`select id, mode, title, updated_at from public.conversations where id = ${conversationId}`;
    if (!conv) return null;
    const rows = await tx<MessageRow[]>`
      select * from (
        select id, role, content, refs, status, client_request_id, created_at, usage,
               status = 'streaming' and updated_at < now() - make_interval(secs => ${STALE_STREAMING_SECONDS}) as stale
        from public.messages where conversation_id = ${conversationId}
        order by created_at desc, id desc limit ${MAX_MESSAGES}
      ) m order by created_at, id`;
    const messages: ChatMessage[] = rows.map((r) => {
      const usage = r.usage ?? {};
      const status: MessageStatus = r.stale ? 'error' : r.status;
      const requestId = r.client_request_id?.endsWith(ASSISTANT_SUFFIX) ? r.client_request_id.slice(0, -ASSISTANT_SUFFIX.length) : r.client_request_id;
      return {
        id: r.id,
        role: r.role,
        content: r.content,
        refs: r.refs,
        status,
        requestId,
        createdAt: r.created_at.toISOString(),
        ...(usage.stopped === true ? { stopped: true } : {}),
        ...(status === 'error' ? { errorCode: r.stale ? 'interrupted' : typeof usage.error === 'string' ? usage.error : 'error' } : {}),
      };
    });
    return { conversation: toSummary(conv), messages };
  });
}

const EVIDENCE_KIND_LABEL: Record<EvidenceKind, string> = {
  execution_output: 'Execution output',
  screenshot: 'Screenshot',
  verification: 'Verification',
  other: 'Evidence',
};

/**
 * What the context picker can offer for a session: its READMEs, the current versions of its own
 * scripts plus any (e.g. universal library) script versions already in `selected`, its LEADS
 * reports and its evidence. Null if the session is not the user's. Labels only — no content.
 */
export function getContextOptionsFor(userId: string, sessionId: string, selected: readonly ResourceRef[]): Promise<ContextOptions | null> {
  if (!UUID_RE.test(sessionId)) return Promise.resolve(null);
  const selectedVersions = selected.filter((r) => r.type === 'script_version' && UUID_RE.test(r.id)).map((r) => r.id).slice(0, 100);
  return withUser(userId, async (tx) => {
    const [session] = await tx`select 1 from public.sessions where id = ${sessionId}`;
    if (!session) return null;
    const readmes = await tx<{ id: string; source: 'paste' | 'upload'; filename: string | null; created_at: Date }[]>`
      select id, source, filename, created_at from public.readmes where session_id = ${sessionId} order by created_at desc`;
    const versions = await tx<{ id: string; version_no: number; name: string; session_id: string | null }[]>`
      select v.id, v.version_no, s.name, s.session_id
      from public.script_versions v join public.scripts s on s.id = v.script_id
      where (s.session_id = ${sessionId} and v.id = s.current_version_id and s.archived_at is null)
         ${selectedVersions.length ? tx`or v.id in ${tx(selectedVersions)}` : tx``}
      order by (s.session_id is null), lower(s.name), v.version_no desc`;
    const reports = await tx<{ id: string; filename: string; cycle_no: number; created_at: Date }[]>`
      select id, filename, cycle_no, created_at from public.leads_reports where session_id = ${sessionId} order by created_at desc`;
    const evidence = await tx<{ id: string; kind: EvidenceKind; step: StepKey; note: string | null; storage_path: string | null; created_at: Date }[]>`
      select id, kind, step, note, storage_path, created_at from public.evidence where session_id = ${sessionId} order by created_at desc`;
    return {
      readmes: readmes.map((r) => ({
        ref: { type: 'readme' as const, id: r.id },
        label: `README · ${r.source === 'upload' ? (r.filename ?? 'file') : 'pasted'}`,
        detail: dateLabel(r.created_at),
      })),
      scriptVersions: versions.map((v) => ({
        ref: { type: 'script_version' as const, id: v.id },
        label: `${v.name} · v${v.version_no}`,
        detail: v.session_id ? 'Session script' : 'Library script',
      })),
      leadsReports: reports.map((r) => ({
        ref: { type: 'leads_report' as const, id: r.id },
        label: `${r.filename} · cycle ${r.cycle_no}`,
        detail: dateLabel(r.created_at),
      })),
      evidence: evidence.map((e) => ({
        ref: { type: 'evidence' as const, id: e.id },
        label: `${EVIDENCE_KIND_LABEL[e.kind]} · ${STEP_LABEL[e.step]}`,
        detail: (e.note?.trim() || basename(e.storage_path) || dateLabel(e.created_at)).slice(0, 120),
      })),
    };
  });
}
