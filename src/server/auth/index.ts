import 'server-only';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { cache } from 'react';
import { readTestSession } from './testAuth';
import { supabaseGetCurrentUser } from './supabase';
import type { AuthMode, AuthUser } from './types';

export type { AuthMode, AuthUser } from './types';

/** ARMADILLO_TEST_AUTH=1 selects the HMAC test provider; anything else is Supabase Auth. */
export function authMode(env: Record<string, string | undefined> = process.env): AuthMode {
  return env.ARMADILLO_TEST_AUTH === '1' ? 'test' : 'supabase';
}

/**
 * The signed-in user for the current request, or null. The only source of a user id for server
 * code: never accept one from the client. Memoized per request.
 */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  // Session-dependent: never prerender at build time (that would also run the provider at build).
  await connection();
  return authMode() === 'test' ? readTestSession() : supabaseGetCurrentUser();
});

/** Like getCurrentUser, but redirects to /login when nobody is signed in. The real auth gate. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}
