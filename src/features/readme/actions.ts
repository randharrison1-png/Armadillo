'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/server/auth';
import {
  createUploadTarget,
  ForbiddenFileError,
  FileTooLargeError,
  readPrivate,
  UnreadableDocumentError,
  UnsupportedFileTypeError,
  uploadPrivate,
  verifyStoredUpload,
  type UploadTarget,
} from '@/server/files/storage';
import type { Readme } from '@/lib/types';
import { addReadmeFor, getReadmeFor, getReadmeOverviewFor, NotFoundError, ReadmeInputError, SessionReadOnlyError, type ReadmeOverview } from './service';

export type ReadmeActionError = { ok: false; error: string };
export type ReadmeAdded = { ok: true; readmeId: string; hasText: boolean };

const revalidate = () => revalidatePath('/app', 'layout');

/** Redirect/auth control-flow errors from requireUser carry a digest and must propagate. */
function rethrowControlFlow(e: unknown) {
  if (typeof e === 'object' && e !== null && 'digest' in e) throw e;
}

function message(e: unknown, fallback: string): string {
  rethrowControlFlow(e);
  if (e instanceof NotFoundError) return 'That session no longer exists.';
  if (e instanceof SessionReadOnlyError || e instanceof ReadmeInputError || e instanceof UnsupportedFileTypeError || e instanceof FileTooLargeError) {
    return e.message;
  }
  if (e instanceof UnreadableDocumentError) return 'That file could not be read. It may be corrupt or password-protected. Paste the README text instead.';
  if (e instanceof ForbiddenFileError) return 'That upload does not belong to this session.';
  return fallback;
}

/**
 * Adds a README to a session from pasted text or a (small) file. Files are stored privately, then
 * their extracted text + segments are saved in the database. Throws on invalid input; the UI uses
 * the *Action wrappers below, which return errors instead.
 */
export async function addReadme(input: { sessionId: string; pasted?: string; file?: File }): Promise<Readme> {
  const user = await requireUser();
  const sessionId = String(input.sessionId);
  let readme: Readme;
  if (input.file) {
    const bytes = new Uint8Array(await input.file.arrayBuffer());
    const { storagePath } = await uploadPrivate(input.file, { kind: 'readme', sessionId });
    readme = await addReadmeFor(user.id, { sessionId, file: { bytes, filename: input.file.name, storagePath } });
  } else {
    readme = await addReadmeFor(user.id, { sessionId, pasted: input.pasted });
  }
  revalidate();
  return readme;
}

export async function addPastedReadmeAction(input: { sessionId: string; pasted: string }): Promise<ReadmeAdded | ReadmeActionError> {
  try {
    const r = await addReadme({ sessionId: String(input.sessionId), pasted: String(input.pasted) });
    return { ok: true, readmeId: r.id, hasText: r.has_text_layer };
  } catch (e) {
    return { ok: false, error: message(e, 'Could not add the README. Try again.') };
  }
}

/** Where the browser should upload a README file (validated by type and size first). */
export async function prepareReadmeUpload(
  sessionId: string,
  filename: string,
  size: number,
): Promise<{ ok: true; target: UploadTarget } | ReadmeActionError> {
  try {
    return { ok: true, target: await createUploadTarget({ kind: 'readme', sessionId: String(sessionId) }, String(filename), Number(size)) };
  } catch (e) {
    return { ok: false, error: message(e, 'Could not start the upload. Try again.') };
  }
}

/**
 * Records a README the browser already uploaded: re-verifies the stored object (owner, type and
 * ACTUAL size, and that it was uploaded for this session), extracts its text, and persists text +
 * segments in the database.
 */
export async function recordUploadedReadme(input: { sessionId: string; storagePath: string }): Promise<ReadmeAdded | ReadmeActionError> {
  try {
    const user = await requireUser();
    const sessionId = String(input.sessionId);
    const storagePath = String(input.storagePath);
    const parts = storagePath.split('/');
    if (parts[1] !== sessionId) throw new ForbiddenFileError();
    await verifyStoredUpload(storagePath, 'readme');
    // Stored as `<uuid>-<sanitized original name>`; the sanitized name keeps the real extension.
    const filename = (parts[parts.length - 1] ?? '').slice(37) || 'readme';
    const readme = await addReadmeFor(user.id, { sessionId, file: { bytes: await readPrivate(storagePath), filename, storagePath } });
    revalidate();
    return { ok: true, readmeId: readme.id, hasText: readme.has_text_layer };
  } catch (e) {
    return { ok: false, error: message(e, 'Could not save the uploaded README. Try again.') };
  }
}

export type ReadmeView = ReadmeOverview & { readme: Readme | null };

/**
 * Data for the README tab: the session's OS/status, every README (newest first) and the one to
 * show: `readmeId` when given, otherwise the latest. Null when the session is not the user's.
 */
export async function loadReadmeView(sessionId: string, readmeId?: string): Promise<ReadmeView | null> {
  const user = await requireUser();
  const overview = await getReadmeOverviewFor(user.id, String(sessionId));
  if (!overview) return null;
  const target = readmeId ?? overview.readmes[0]?.id;
  if (!target || !overview.readmes.some((r) => r.id === target)) return { ...overview, readme: null };
  return { ...overview, readme: await getReadmeFor(user.id, target) };
}
