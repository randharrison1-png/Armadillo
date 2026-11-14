'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { safeNext } from '@/lib/safeNext';
import { authMode } from './index';
import { createSupabaseServerClient } from './supabase';
import { normalizeEmail, testSignIn, testSignOut } from './testAuth';

export type AuthFormState = { error?: string; message?: string };

const INVALID_EMAIL = 'Enter a valid email address.';

/** Test provider only (ARMADILLO_TEST_AUTH=1). testSignIn re-checks the production guard. */
export async function signInWithEmail(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  if (authMode() !== 'test') return { error: 'Email-only sign-in is not available.' };
  const email = normalizeEmail(formData.get('email'));
  if (!email) return { error: INVALID_EMAIL };
  await testSignIn(email);
  redirect(safeNext(formData.get('next')));
}

function credentials(formData: FormData): { email: string; password: string } | { error: string } {
  const email = normalizeEmail(formData.get('email'));
  const password = formData.get('password');
  if (!email) return { error: INVALID_EMAIL };
  if (typeof password !== 'string' || password.length < 8) return { error: 'Password must be at least 8 characters.' };
  return { email, password };
}

/** Supabase provider: email + password sign-in. */
export async function signInWithPassword(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  if (authMode() !== 'supabase') return { error: 'Password sign-in is not available.' };
  const input = credentials(formData);
  if ('error' in input) return input;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(input);
  if (error) return { error: 'Email or password is incorrect.' };
  redirect(safeNext(formData.get('next')));
}

/** Supabase provider: create an account. Signs in directly unless email confirmation is required. */
export async function signUpWithPassword(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  if (authMode() !== 'supabase') return { error: 'Sign-up is not available.' };
  const input = credentials(formData);
  if ('error' in input) return input;
  const supabase = await createSupabaseServerClient();
  const origin = (await headers()).get('origin');
  const { data, error } = await supabase.auth.signUp({
    ...input,
    options: origin ? { emailRedirectTo: `${origin}/auth/confirm` } : undefined,
  });
  if (error) {
    // Generic message except for password rules, so sign-up does not reveal which emails exist.
    return { error: error.code === 'weak_password' ? error.message : 'Could not create an account with that email and password.' };
  }
  if (!data.session) return { message: 'Check your email to confirm your account, then sign in.' };
  redirect(safeNext(formData.get('next')));
}

/** Clears the session for whichever provider is active, then returns to /login. */
export async function signOut(): Promise<void> {
  if (authMode() === 'test') {
    await testSignOut();
  } else {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  }
  redirect('/login');
}
