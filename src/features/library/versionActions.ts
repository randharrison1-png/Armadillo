'use server';

import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireUser } from '@/server/auth';
import type { Script, ScriptVersion } from '@/lib/types';
import type { UpdateScriptInput } from './schema';
import {
  ContentTooLargeError,
  forkToSessionFor,
  ForbiddenEditError,
  getScriptEditorDataFor,
  getVersionFor,
  NotFoundError,
  restoreVersionFor,
  saveScriptVersionFor,
  updateScriptMetadataFor,
} from './versioning';
import type { SaveResult, ScriptEditorData } from './versionTypes';

export type ActionError = { ok: false; error: string };
export type MetaErrors = Partial<Record<'name' | 'category' | 'description' | 'osCompat' | 'form', string>>;

const revalidate = () => revalidatePath('/app', 'layout');

/** Redirect/auth control-flow errors from requireUser carry a digest and must propagate. */
function rethrowControlFlow(e: unknown) {
  if (typeof e === 'object' && e !== null && 'digest' in e) throw e;
}

function message(e: unknown, fallback: string): string {
  rethrowControlFlow(e);
  if (e instanceof NotFoundError) return 'That script or version no longer exists.';
  if (e instanceof ForbiddenEditError || e instanceof ContentTooLargeError) return e.message;
  return fallback;
}

/** Script, current version (with content) and history, for the editor tab. */
export async function loadScriptEditor(scriptId: string): Promise<ScriptEditorData | null> {
  const user = await requireUser();
  return getScriptEditorDataFor(user.id, scriptId);
}

/** One version with content (read-only views and diffs). */
export async function loadVersion(versionId: string): Promise<{ script: Script; version: ScriptVersion } | null> {
  const user = await requireUser();
  return getVersionFor(user.id, versionId);
}

/** Editor "Save version". Always author 'user': only server code (Task 14) may record Claude as the author. */
export async function saveScriptVersionAction(input: {
  scriptId: string;
  baseVersionId: string | null;
  content: string;
  changeNote?: string;
}): Promise<{ ok: true; result: SaveResult } | ActionError> {
  try {
    const user = await requireUser();
    const result = await saveScriptVersionFor(user.id, {
      scriptId: String(input.scriptId),
      baseVersionId: input.baseVersionId === null ? null : String(input.baseVersionId),
      content: String(input.content),
      changeNote: typeof input.changeNote === 'string' ? input.changeNote.slice(0, 500) : undefined,
      author: 'user',
    });
    if (result.status === 'created') revalidate();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: message(e, 'Could not save the version. Try again.') };
  }
}

/** "Restore": a new version equal to an older one. */
export async function restoreVersionAction(input: {
  scriptId: string;
  versionId: string;
  baseVersionId: string | null;
}): Promise<{ ok: true; result: SaveResult } | ActionError> {
  try {
    const user = await requireUser();
    const result = await restoreVersionFor(user.id, {
      scriptId: String(input.scriptId),
      versionId: String(input.versionId),
      baseVersionId: input.baseVersionId === null ? null : String(input.baseVersionId),
    });
    if (result.status === 'created') revalidate();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: message(e, 'Could not restore the version. Try again.') };
  }
}

/** Copies a version into an active session as a session script. */
export async function forkToSessionAction(input: {
  versionId: string;
  sessionId: string;
}): Promise<{ ok: true; scriptId: string; filename: string; sessionId: string } | ActionError> {
  try {
    const user = await requireUser();
    const script = await forkToSessionFor(user.id, { versionId: String(input.versionId), sessionId: String(input.sessionId) });
    revalidate();
    return { ok: true, scriptId: script.id, filename: script.filename, sessionId: script.session_id! };
  } catch (e) {
    return { ok: false, error: message(e, 'Could not copy the script into the session. Try again.') };
  }
}

/** Name / category / systems / description. */
export async function updateScriptMetadataAction(
  scriptId: string,
  input: UpdateScriptInput,
): Promise<{ ok: true; script: Script } | { ok: false; errors: MetaErrors }> {
  try {
    const user = await requireUser();
    const script = await updateScriptMetadataFor(user.id, String(scriptId), input);
    revalidate();
    return { ok: true, script };
  } catch (e) {
    rethrowControlFlow(e);
    if (e instanceof ZodError) {
      const errors: MetaErrors = {};
      for (const issue of e.issues) {
        const key = issue.path[0];
        if (typeof key === 'string' && ['name', 'category', 'description', 'osCompat'].includes(key) && !errors[key as keyof MetaErrors]) {
          errors[key as keyof MetaErrors] = issue.message;
        }
      }
      return { ok: false, errors: Object.keys(errors).length ? errors : { form: 'Check the details and try again.' } };
    }
    return { ok: false, errors: { form: message(e, 'Could not save the details. Try again.') } };
  }
}
