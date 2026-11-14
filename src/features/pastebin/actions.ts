'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireUser } from '@/server/auth';
import { KeyEncryptionConfigError } from '@/server/security/crypto';
import { clientIp, reporterHash } from '@/server/security/abuse';
import { publishPaste, SlugCollisionError } from './create';
import { PublishRefused } from './publish';
import { reportPasteFor, type ReportInput } from './report';
import { deletePasteFor, getOwnPaste, PasteNotFoundError, updatePasteFor, type OwnPasteWithContent } from './service';
import type { PublishPasteInput, PublishRefusal, UpdatePasteInput } from './schema';

export type PasteFieldErrors = Partial<Record<'title' | 'content' | 'language' | 'visibility' | 'expiresAt' | 'expiresIn' | 'form', string>>;
export type PasteActionResult = { ok: true } | { ok: false; errors: PasteFieldErrors } | { ok: false; refusal: PublishRefusal };

const isControlFlow = (e: unknown) => typeof e === 'object' && e !== null && 'digest' in e;

function toErrors(e: unknown, fallback: string): PasteFieldErrors {
  if (isControlFlow(e)) throw e;
  if (e instanceof PasteNotFoundError) return { form: 'This paste no longer exists or is not yours.' };
  if (e instanceof ZodError) {
    const errors: PasteFieldErrors = {};
    for (const issue of e.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && ['title', 'content', 'language', 'visibility', 'expiresAt', 'expiresIn'].includes(key) && !errors[key as keyof PasteFieldErrors]) {
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
    if (e instanceof PublishRefused) return { ok: false, refusal: e.refusal };
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

export type PublishActionResult = { ok: true; slug: string } | { ok: false; errors: PasteFieldErrors } | { ok: false; refusal: PublishRefusal };

/**
 * Publishes a new paste. Called only by PublishDialog (tests/unit/publish-boundary.test.ts), i.e.
 * only after the user pressed Publish (and confirmed the private source / acknowledged the secret
 * warning when asked). The owner is the session user, never a value from the request.
 */
export async function publishPasteAction(input: PublishPasteInput): Promise<PublishActionResult> {
  try {
    const user = await requireUser();
    const { slug } = await publishPaste(user.id, input);
    revalidatePath('/app/pastes');
    revalidatePath('/p');
    return { ok: true, slug };
  } catch (e) {
    if (isControlFlow(e)) throw e;
    if (e instanceof PublishRefused) return { ok: false, refusal: e.refusal };
    if (e instanceof SlugCollisionError) return { ok: false, errors: { form: e.message } };
    return { ok: false, errors: toErrors(e, 'Could not publish the paste. Try again.') };
  }
}

export type ReportActionResult = { ok: true } | { ok: false; error: string; retryAfter?: number };

/** Abuse report for a live paste; works signed out. */
export async function reportPasteAction(input: ReportInput): Promise<ReportActionResult> {
  try {
    const hash = reporterHash(clientIp(await headers()));
    const r = await reportPasteFor(input, hash);
    if (r.status === 'stored') return { ok: true };
    if (r.status === 'rate_limited') return { ok: false, error: 'You have sent several reports recently.', retryAfter: r.retryAfter };
    return { ok: false, error: 'This paste no longer exists.' };
  } catch (e) {
    if (isControlFlow(e)) throw e;
    if (e instanceof ZodError) return { ok: false, error: e.issues[0]?.message ?? 'Check the report and try again.' };
    if (e instanceof KeyEncryptionConfigError) return { ok: false, error: 'Reporting is unavailable right now.' };
    return { ok: false, error: 'Could not send the report. Try again.' };
  }
}
