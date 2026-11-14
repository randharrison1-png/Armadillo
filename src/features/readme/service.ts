import 'server-only';
import { logActivity } from '@/server/activity';
import { withUser } from '@/server/db/withUser';
import { extractDocument, type ExtractedDocument } from '@/server/files/extract';
import { MAX_TEXT_BYTES } from '@/server/files/limits';
import { setStepStatus } from '@/features/flowchart/steps';
import type { OsType, Readme, StepStatus } from '@/lib/types';

/** Pasted README text is capped like any other text input (2 MB of UTF-8). */
export const MAX_PASTED_BYTES = MAX_TEXT_BYTES;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class NotFoundError extends Error {
  readonly name = 'NotFoundError';
  constructor(what = 'Session') {
    super(`${what} not found`);
  }
}
export class SessionReadOnlyError extends Error {
  readonly name = 'SessionReadOnlyError';
  constructor() {
    super('This session is completed and read-only.');
  }
}
/** The input is not an acceptable README (empty, too large, wrong combination). Message is user-facing. */
export class ReadmeInputError extends Error {
  readonly name = 'ReadmeInputError';
}

export type ReadmeSummary = Pick<Readme, 'id' | 'source' | 'filename' | 'has_text_layer' | 'created_at'> & { segment_count: number };

export type ReadmeFileInput = { bytes: Uint8Array; filename: string; storagePath?: string };

/**
 * Records a README for a session. Pasted text runs through the same extractor as an uploaded
 * .md file, so identical text always yields identical segment ids. Extracted text and segments
 * are persisted here; the stored file is never the source of truth. Existing README rows are
 * never touched: a re-add is a new row (requirements reference a specific readme_id).
 *
 * After a README with text is recorded, the session's open_readme step moves not_started ->
 * in_progress (own transaction; a failure there does not undo the README). A scanned PDF (no text
 * layer) is stored with empty segments and does not move the step.
 *
 * Throws NotFoundError (missing or foreign session), SessionReadOnlyError, ReadmeInputError, and
 * the extractor's UnsupportedFileTypeError / FileTooLargeError / UnreadableDocumentError.
 */
export async function addReadmeFor(
  userId: string,
  input: { sessionId: string; pasted?: string; file?: ReadmeFileInput },
): Promise<Readme> {
  if ((input.pasted === undefined) === (input.file === undefined)) {
    throw new ReadmeInputError('Paste the README text or choose a file.');
  }
  let doc: ExtractedDocument;
  let source: Readme['source'];
  let filename: string | null = null;
  let storagePath: string | null = null;
  if (input.pasted !== undefined) {
    if (input.pasted.trim() === '') throw new ReadmeInputError('Paste the README text first.');
    const bytes = new TextEncoder().encode(input.pasted);
    if (bytes.byteLength > MAX_PASTED_BYTES) throw new ReadmeInputError('That text is over 2 MB. Paste a shorter README.');
    doc = await extractDocument(bytes, 'pasted.md');
    source = 'paste';
  } else {
    const { bytes, filename: name } = input.file!;
    doc = await extractDocument(bytes, name);
    // A scan has blank page segments; store none so nothing can be linked to empty text.
    if (!doc.hasTextLayer) doc = { text: '', segments: [], hasTextLayer: false };
    if (!doc.hasTextLayer && !name.toLowerCase().endsWith('.pdf')) throw new ReadmeInputError('That file has no text.');
    source = 'upload';
    filename = name;
    storagePath = input.file!.storagePath ?? null;
  }

  const { readme, openStatus } = await withUser(userId, async (tx) => {
    if (!UUID_RE.test(input.sessionId)) throw new NotFoundError();
    const [session] = await tx<{ status: 'active' | 'completed' }[]>`select status from public.sessions where id = ${input.sessionId}`;
    if (!session) throw new NotFoundError();
    if (session.status === 'completed') throw new SessionReadOnlyError();
    const [row] = await tx<Readme[]>`
      insert into public.readmes (session_id, source, filename, storage_path, text, segments, has_text_layer)
      values (${input.sessionId}, ${source}, ${filename}, ${storagePath}, ${doc.text}, ${tx.json(doc.segments as never)}, ${doc.hasTextLayer})
      returning *`;
    await logActivity(tx, {
      action: 'readme.add',
      entityType: 'readme',
      entityId: row.id,
      sessionId: input.sessionId,
      meta: { source, hasTextLayer: doc.hasTextLayer, segments: doc.segments.length, filename },
    });
    const [step] = await tx<{ status: StepStatus }[]>`
      select status from public.workflow_steps where session_id = ${input.sessionId} and step = 'open_readme'`;
    return { readme: row, openStatus: step?.status ?? null };
  });

  if (doc.hasTextLayer && openStatus === 'not_started') {
    try {
      await setStepStatus({ sessionId: input.sessionId, step: 'open_readme', status: 'in_progress' });
    } catch (e) {
      console.error('Could not mark open_readme in progress', e);
    }
  }
  return readme;
}

export type ReadmeOverview = {
  os: OsType;
  sessionStatus: 'active' | 'completed';
  openReadmeStatus: StepStatus;
  /** Newest first. */
  readmes: ReadmeSummary[];
};

/** The session's README list (no text), OS, status and open_readme step. Null when the session is not the user's. */
export function getReadmeOverviewFor(userId: string, sessionId: string): Promise<ReadmeOverview | null> {
  if (!UUID_RE.test(sessionId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const [session] = await tx<{ os: OsType; status: 'active' | 'completed' }[]>`select os, status from public.sessions where id = ${sessionId}`;
    if (!session) return null;
    const [step] = await tx<{ status: StepStatus }[]>`
      select status from public.workflow_steps where session_id = ${sessionId} and step = 'open_readme'`;
    const readmes = await tx<ReadmeSummary[]>`
      select id, source, filename, has_text_layer, created_at, jsonb_array_length(segments)::int as segment_count
      from public.readmes where session_id = ${sessionId} order by created_at desc, id`;
    return { os: session.os, sessionStatus: session.status, openReadmeStatus: step?.status ?? 'not_started', readmes };
  });
}

export async function listReadmesFor(userId: string, sessionId: string): Promise<ReadmeSummary[]> {
  return (await getReadmeOverviewFor(userId, sessionId))?.readmes ?? [];
}

/** One README with text and segments, if it exists and the user owns it (RLS). */
export function getReadmeFor(userId: string, readmeId: string): Promise<Readme | null> {
  if (!UUID_RE.test(readmeId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const [row] = await tx<Readme[]>`select * from public.readmes where id = ${readmeId}`;
    return row ?? null;
  });
}
