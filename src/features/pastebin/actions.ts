'use server';

import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireUser } from '@/server/auth';
import { deletePasteFor, getOwnPaste, PasteNotFoundError, updatePasteFor, type OwnPasteWithContent } from './service';
import type { UpdatePasteInput } from './schema';

export type PasteFieldErrors = Partial<Record<'title' | 'content' | 'language' | 'visibility' | 'expiresAt' | 'form', string>>;
export type PasteActionResult = { ok: true } | { ok: false; errors: PasteFieldErrors };

const isControlFlow = (e: unknown) => typeof e === 'object' && e !== null && 'digest' in e;

function toErrors(e: unknown, fallback: string): PasteFieldErrors {
  if (isControlFlow(e)) throw e;
  if (e instanceof PasteNotFoundError) return { form: 'This paste no longer exists or is not yours.' };
  if (e instanceof ZodError) {
    const errors: PasteFieldErrors = {};
    for (const issue of e.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && ['title', 'content', 'language', 'visibility', 'expiresAt'].includes(key) && !errors[key as keyof PasteFieldErrors]) {
        errors[key as keyof PasteFieldErrors] = issue.message;
      }
    }
    return Object.keys(errors).length ? errors : { form: fallback };
  }
  return { form: fallback };
}

const revalidate = (slug: string) => {
  revalidatePath('/app/pastes');
  revalidatePath('/p');
  revalidatePath(`/p/${slug}`);
};

/** Owner-only edit of title / content / language / visibility / expiry. */
export async function updatePaste(input: UpdatePasteInput): Promise<PasteActionResult> {
  try {
    const user = await requireUser();
    await updatePasteFor(user.id, input);
    revalidate(String(input.slug));
    return { ok: true };
  } catch (e) {
    return { ok: false, errors: toErrors(e, 'Could not save the paste. Try again.') };
  }
}

/** Owner-only soft delete. */
export async function deletePaste(slug: string): Promise<PasteActionResult> {
  try {
    const user = await requireUser();
    await deletePasteFor(user.id, String(slug));
    revalidate(String(slug));
    return { ok: true };
  } catch (e) {
    return { ok: false, errors: toErrors(e, 'Could not delete the paste. Try again.') };
  }
}

/** Loads one of the user's own pastes (with content) into the editor. */
export async function loadOwnPaste(slug: string): Promise<{ ok: true; paste: OwnPasteWithContent } | { ok: false; error: string }> {
  try {
    const user = await requireUser();
    const paste = await getOwnPaste(user.id, String(slug));
    return paste ? { ok: true, paste } : { ok: false, error: 'This paste no longer exists.' };
  } catch (e) {
    if (isControlFlow(e)) throw e;
    return { ok: false, error: 'Could not load the paste. Try again.' };
  }
}
