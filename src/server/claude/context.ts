import 'server-only';
import type { OsType, ResourceRef } from '@/lib/types';
import { withUser, type Tx } from '@/server/db/withUser';
import { allocateBodies, newNonce, type RenderableDoc } from './documents';
import { buildSystemPrompt } from './prompts/system';

/** The user's message names a resource Claude may not see in this session. Messages are user-facing. */
export class ForbiddenError extends Error {
  readonly name = 'ForbiddenError';
  constructor() {
    super("One of the selected items isn't available in this session.");
  }
}

export type AssembledContext = {
  /** System prompt for the request. */
  system: string;
  /** Rendered documents for the selected resources ('' when none). Sent before the user's text. */
  documents: string;
  /** Selected resources that were shortened to fit the budget. */
  trimmed: ResourceRef[];
  /** The per-request code in the tag names and segment markers (see documents.ts). */
  nonce: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REFS = 50;

type Loader = (tx: Tx, id: string, sessionId: string) => Promise<RenderableDoc | null>;

const line = (label: string, value: string | number | null | undefined) => `${label}: ${value ?? '—'}`;

/**
 * One loader per resource type. Each runs with the user's RLS client (another user's rows are
 * invisible) AND checks the session explicitly: the resource must belong to this session. Script
 * versions may also belong to a universal library script (session_id null), which is how a script
 * "chosen from the library" reaches an adaptation.
 */
const LOADERS: Record<ResourceRef['type'], Loader> = {
  async readme(tx, id, sessionId) {
    const [r] = await tx<{ id: string; filename: string | null; source: string; text: string; segments: { id: string; text: string }[] }[]>`
      select id, filename, source, text, segments from public.readmes where id = ${id} and session_id = ${sessionId}`;
    if (!r) return null;
    const segments = Array.isArray(r.segments) ? r.segments : [];
    return {
      ref: { type: 'readme', id: r.id },
      title: r.filename ?? 'Pasted README',
      head: [line('source', r.source), ...(r.filename ? [line('filename', r.filename)] : [])].join('\n'),
      body: r.text,
      ...(segments.length ? { segments } : {}),
      fenced: false,
    };
  },
  async script_version(tx, id, sessionId) {
    const [v] = await tx<{ id: string; version_no: number; content: string; language: string; name: string; filename: string }[]>`
      select v.id, v.version_no, v.content, v.language, s.name, s.filename
      from public.script_versions v join public.scripts s on s.id = v.script_id
      where v.id = ${id} and (s.session_id = ${sessionId} or s.session_id is null)`;
    if (!v) return null;
    return {
      ref: { type: 'script_version', id: v.id },
      title: `${v.name} · v${v.version_no}`,
      head: [line('filename', v.filename), line('language', v.language), line('version', v.version_no)].join('\n'),
      body: v.content,
      fenced: true,
    };
  },
  async leads_report(tx, id, sessionId) {
    const [r] = await tx<{ id: string; filename: string; cycle_no: number; raw_text: string | null }[]>`
      select id, filename, cycle_no, raw_text from public.leads_reports where id = ${id} and session_id = ${sessionId}`;
    if (!r) return null;
    return {
      ref: { type: 'leads_report', id: r.id },
      title: r.filename,
      head: [line('filename', r.filename), line('cycle', r.cycle_no)].join('\n'),
      body: r.raw_text ?? '',
      fenced: false,
    };
  },
  async evidence(tx, id, sessionId) {
    // Only the text metadata: file contents (screenshots, uploads) are never sent.
    const [e] = await tx<{ id: string; kind: string; step: string; note: string | null }[]>`
      select id, kind, step, note from public.evidence where id = ${id} and session_id = ${sessionId}`;
    if (!e) return null;
    return {
      ref: { type: 'evidence', id: e.id },
      title: `Evidence · ${e.kind}`,
      head: [line('kind', e.kind), line('step', e.step)].join('\n'),
      body: e.note ?? '',
      fenced: false,
    };
  },
};

/**
 * Builds what Claude sees for one request: the system prompt (OS and title read from the database)
 * and exactly the selected resources, each loaded with the user's own RLS client and checked against
 * the session NOW (Retry reuses the refs stored on the original message, so a store-time check
 * alone would not be enough). Anything missing, someone else's, or from another session throws
 * ForbiddenError without saying which. Nothing else is ever added to the context.
 */
export async function buildContext(input: {
  userId: string;
  sessionId: string;
  refs: ResourceRef[];
  budgetTokens: number;
  /** Tests only; production uses a fresh random nonce. */
  nonce?: string;
  /** Structured calls: the one (recording-only) tool this request forces; the system prompt names it. */
  structuredTool?: string;
}): Promise<AssembledContext> {
  const { userId, sessionId, budgetTokens } = input;
  if (!UUID_RE.test(sessionId) || input.refs.length > MAX_REFS) throw new ForbiddenError();
  const seen = new Set<string>();
  const refs = input.refs.filter((r) => (seen.has(`${r.type}:${r.id}`) ? false : (seen.add(`${r.type}:${r.id}`), true)));
  for (const r of refs) {
    if (!Object.hasOwn(LOADERS, r.type) || !UUID_RE.test(r.id)) throw new ForbiddenError();
  }

  const { session, docs } = await withUser(userId, async (tx) => {
    const [row] = await tx<{ os: OsType; title: string }[]>`select os, title from public.sessions where id = ${sessionId}`;
    if (!row) throw new ForbiddenError();
    const loaded: RenderableDoc[] = [];
    for (const r of refs) {
      const doc = await LOADERS[r.type](tx, r.id, sessionId);
      if (!doc) throw new ForbiddenError();
      loaded.push(doc);
    }
    return { session: row, docs: loaded };
  });

  const nonce = input.nonce ?? newNonce();
  const { blocks, trimmed } = allocateBodies(docs, budgetTokens, nonce);
  return { system: buildSystemPrompt(session, nonce, { structuredTool: input.structuredTool }), documents: blocks.join('\n\n'), trimmed, nonce };
}
