'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/server/auth';
import type { Session } from '@/lib/types';
import { createSessionSchema, type CreateSessionInput } from './schema';
import { createSessionFor } from './service';

export type CreateSessionResult =
  | { ok: true; sessionId: string }
  | { ok: false; errors: { title?: string; os?: string; form?: string } };

/** Validates, then creates the session (+ 9 steps + activity entry) in one database transaction. */
export async function createSession(input: CreateSessionInput): Promise<Session> {
  const parsed = createSessionSchema.parse(input);
  const user = await requireUser();
  const session = await createSessionFor(user.id, parsed);
  revalidatePath('/app', 'layout');
  return session;
}

/** Form-facing variant of createSession: returns field errors instead of throwing. */
export async function createSessionAction(input: { title: string; os: string }): Promise<CreateSessionResult> {
  const parsed = createSessionSchema.safeParse(input);
  if (!parsed.success) {
    const errors: { title?: string; os?: string } = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if ((key === 'title' || key === 'os') && !errors[key]) errors[key] = issue.message;
    }
    return { ok: false, errors };
  }
  try {
    const session = await createSession(parsed.data);
    return { ok: true, sessionId: session.id };
  } catch (error) {
    // Redirect/auth control-flow errors from requireUser carry a digest and must propagate.
    if (typeof error === 'object' && error !== null && 'digest' in error) throw error;
    return { ok: false, errors: { form: 'Could not create the session. Try again.' } };
  }
}
