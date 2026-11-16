import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { getPool } from '@/server/db/pool';
import type { AuthUser } from './types';

/**
 * Test-only auth provider (ARMADILLO_TEST_AUTH=1): an email-only sign-in that upserts auth.users
 * and issues an HMAC-SHA256 signed session cookie. It must never run in production, so every
 * entry point calls assertTestAuthAllowed(), and src/instrumentation.ts calls it at server start.
 *
 * Cookie value: `<userId>.<base64url(email)>.<expiresAtUnixSeconds>.<base64url(hmac)>`, where the
 * HMAC covers the first three parts. The email is base64url-encoded so dots in it cannot shift the
 * fields.
 */

export const TEST_AUTH_COOKIE = 'armadillo_test_session';
export const TEST_SESSION_TTL_SECONDS = 12 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

type Env = Record<string, string | undefined>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Throws unless the test provider may run; returns TEST_AUTH_SECRET.
 * Reads the environment at runtime (`env.NODE_ENV`, not the `process.env.NODE_ENV` literal that
 * Next inlines as "production" in every build), so `next start` refuses unless the process was
 * explicitly started with a non-production NODE_ENV.
 */
export function assertTestAuthAllowed(env: Env = process.env): string {
  if (env.ARMADILLO_TEST_AUTH !== '1') {
    throw new Error('Test auth is disabled: ARMADILLO_TEST_AUTH is not "1".');
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to start test auth: NODE_ENV is "production". Test auth is for local and CI tests only.');
  }
  if (env.VERCEL !== undefined) {
    throw new Error('Refusing to start test auth: VERCEL is set. Test auth must never run on a deployment.');
  }
  // Supabase production credentials mean a real deployment (or one configured like it) even when
  // NODE_ENV and VERCEL look harmless, e.g. a self-hosted server started with NODE_ENV=test.
  for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL'] as const) {
    if (env[name]?.trim()) {
      throw new Error(`Refusing to start test auth: ${name} is set. Test auth must never run against a Supabase project.`);
    }
  }
  const secret = env.TEST_AUTH_SECRET;
  if (!secret) throw new Error('TEST_AUTH_SECRET is required when ARMADILLO_TEST_AUTH=1.');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`TEST_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  return secret;
}

function mac(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function signTestSession(
  user: AuthUser,
  secret: string,
  nowMs: number = Date.now(),
  ttlSeconds: number = TEST_SESSION_TTL_SECONDS,
): string {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const payload = `${user.id}.${Buffer.from(user.email, 'utf8').toString('base64url')}.${exp}`;
  return `${payload}.${mac(payload, secret).toString('base64url')}`;
}

/** Returns the user for a valid, unexpired token signed with `secret`; otherwise null. Never throws. */
export function verifyTestSession(token: string | undefined, secret: string, nowMs: number = Date.now()): AuthUser | null {
  if (!token || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [id, emailB64, expRaw, sigB64] = parts;
  if (!UUID_RE.test(id) || !B64URL_RE.test(emailB64) || !/^\d{1,12}$/.test(expRaw) || !B64URL_RE.test(sigB64)) {
    return null;
  }

  const expected = mac(`${id}.${emailB64}.${expRaw}`, secret);
  const given = Buffer.from(sigB64, 'base64url');
  // Length check first (timingSafeEqual requires equal lengths); the length is public anyway.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  if (Math.floor(nowMs / 1000) >= Number(expRaw)) return null;

  const email = Buffer.from(emailB64, 'base64url').toString('utf8');
  if (!EMAIL_RE.test(email)) return null;
  return { id: id.toLowerCase(), email };
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    // Next inlines this literal: true in every `next build` (incl. the e2e server; Chromium accepts
    // Secure cookies on 127.0.0.1), false under `next dev` so plain-http dev sign-in works.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  };
}

/** Reads and verifies the session cookie of the current request. */
export async function readTestSession(): Promise<AuthUser | null> {
  const secret = assertTestAuthAllowed();
  const store = await cookies();
  return verifyTestSession(store.get(TEST_AUTH_COOKIE)?.value, secret);
}

/** Normalizes and validates an email for test sign-in; returns null when invalid. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

/**
 * Upserts auth.users by email and sets the session cookie. Must be called from a server action.
 * Uses the raw pool (the connecting admin role): API roles cannot write auth.users, and this
 * provider only exists in tests.
 */
export async function testSignIn(email: string): Promise<AuthUser> {
  const secret = assertTestAuthAllowed();
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error('Invalid email');

  const [row] = await getPool()<{ id: string; email: string }[]>`
    insert into auth.users (email) values (${normalized})
    on conflict (email) do update set email = excluded.email
    returning id, email`;
  const user = { id: row.id, email: row.email };

  const store = await cookies();
  store.set(TEST_AUTH_COOKIE, signTestSession(user, secret), cookieOptions(TEST_SESSION_TTL_SECONDS));
  return user;
}

export async function testSignOut(): Promise<void> {
  assertTestAuthAllowed();
  const store = await cookies();
  store.set(TEST_AUTH_COOKIE, '', cookieOptions(0));
}
