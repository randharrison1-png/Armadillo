'use server';

import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireUser } from '@/server/auth';
import {
  createUploadTarget,
  FileTooLargeError,
  readPrivate,
  UnsupportedFileTypeError,
  verifyStoredUpload,
  type UploadTarget,
} from '@/server/files/storage';
import type { Script } from '@/lib/types';
import { createScriptSchema, type CreateScriptInput, type ScriptMeta } from './schema';
import { createScriptFor, createScriptFromUploadFor, duplicateScriptFor, getScriptWithContentFor } from './service';

export type FieldErrors = Partial<
  Record<'name' | 'filename' | 'category' | 'fn' | 'description' | 'osCompat' | 'content' | 'file' | 'form', string>
>;
export type ScriptResult = { ok: true; scriptId: string; name: string } | { ok: false; errors: FieldErrors };

const revalidate = () => revalidatePath('/app', 'layout');

/** Redirect/auth control-flow errors from requireUser carry a digest and must propagate. */
function isControlFlow(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'digest' in e;
}

function toErrors(e: unknown, fallback: string): FieldErrors {
  if (isControlFlow(e)) throw e;
  if (e instanceof ZodError) {
    const errors: FieldErrors = {};
    for (const issue of e.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && key in { name: 1, filename: 1, category: 1, fn: 1, description: 1, osCompat: 1, content: 1 } && !errors[key as keyof FieldErrors]) {
        errors[key as keyof FieldErrors] = issue.message;
      }
    }
    return Object.keys(errors).length ? errors : { form: fallback };
  }
  if (e instanceof UnsupportedFileTypeError || e instanceof FileTooLargeError) return { file: e.message };
  return { form: fallback };
}

/** Creates a universal library script at version 1. Throws on invalid input. */
export async function createScript(input: CreateScriptInput): Promise<Script> {
  const user = await requireUser();
  // Parse first: unknown keys (e.g. a client-supplied `format`) are stripped, so in-app scripts always
  // get the per-extension format and normalized newlines.
  const script = await createScriptFor(user.id, createScriptSchema.parse(input));
  revalidate();
  return script;
}

/** Form-facing createScript: returns field errors instead of throwing. */
export async function createScriptAction(input: CreateScriptInput): Promise<ScriptResult> {
  try {
    const s = await createScript(input);
    return { ok: true, scriptId: s.id, name: s.name };
  } catch (e) {
    return { ok: false, errors: toErrors(e, 'Could not create the script. Try again.') };
  }
}

/** Where the browser should upload a script file (validated by type and size first). */
export async function prepareScriptUpload(
  filename: string,
  size: number,
): Promise<{ ok: true; target: UploadTarget } | { ok: false; errors: FieldErrors }> {
  try {
    return { ok: true, target: await createUploadTarget({ kind: 'script' }, filename, size) };
  } catch (e) {
    return { ok: false, errors: toErrors(e, 'Could not start the upload. Try again.') };
  }
}

/**
 * Records a script the browser already uploaded: re-verifies the stored object (owner, type and
 * ACTUAL size), reads its bytes, and persists the decoded text + sha256 in the database (the DB is
 * the source of truth; the stored file is not read again).
 */
export async function recordUploadedScript(input: ScriptMeta & { storagePath: string }): Promise<ScriptResult> {
  try {
    const user = await requireUser();
    const { storagePath, ...rest } = input;
    const meta = createScriptSchema.omit({ content: true }).parse(rest);
    await verifyStoredUpload(storagePath, 'script');
    const script = await createScriptFromUploadFor(user.id, meta, await readPrivate(storagePath), { storagePath });
    revalidate();
    return { ok: true, scriptId: script.id, name: script.name };
  } catch (e) {
    return { ok: false, errors: toErrors(e, 'Could not save the uploaded script. Try again.') };
  }
}

/** "Copy": a new universal script at v1 from the source's current version. Throws if the source is not found. */
export async function duplicateScript(scriptId: string): Promise<Script> {
  const user = await requireUser();
  const script = await duplicateScriptFor(user.id, scriptId);
  revalidate();
  return script;
}

export async function duplicateScriptAction(scriptId: string): Promise<ScriptResult> {
  try {
    const s = await duplicateScript(scriptId);
    return { ok: true, scriptId: s.id, name: s.name };
  } catch (e) {
    if (isControlFlow(e)) throw e;
    return { ok: false, errors: { form: e instanceof Error && e.message === 'Script not found' ? 'That script no longer exists.' : 'Could not copy the script. Try again.' } };
  }
}

/** Current version text, for "Copy to clipboard". */
export async function getScriptContent(scriptId: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const found = await getScriptWithContentFor(user.id, scriptId);
  return found ? { ok: true, content: found.version.content } : { ok: false, error: 'That script no longer exists.' };
}
