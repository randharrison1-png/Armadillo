// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertTestAuthAllowed,
  readTestSession,
  signTestSession,
  TEST_SESSION_TTL_SECONDS,
  verifyTestSession,
} from '@/server/auth/testAuth';

const SECRET = 'unit-test-secret-0123456789abcdef-xyz';
const USER = { id: '3f0c8a52-6a1b-4a8e-9c3e-2d6f1b7a9e10', email: 'ada.lovelace@example.test' };
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);

const okEnv = { NODE_ENV: 'test', ARMADILLO_TEST_AUTH: '1', TEST_AUTH_SECRET: SECRET };

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Replaces one dot-separated part of the token. */
function withPart(token: string, index: number, value: string): string {
  const parts = token.split('.');
  parts[index] = value;
  return parts.join('.');
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('test auth provider guard', () => {
  it('test auth refuses to start when NODE_ENV is production or VERCEL is set', () => {
    expect(() => assertTestAuthAllowed({ ...okEnv, NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => assertTestAuthAllowed({ ...okEnv, VERCEL: '1' })).toThrow(/VERCEL/);
    expect(() => assertTestAuthAllowed({ ...okEnv, NODE_ENV: 'development', VERCEL: '' })).toThrow(/VERCEL/);
    expect(assertTestAuthAllowed(okEnv)).toBe(SECRET);
    expect(assertTestAuthAllowed({ ...okEnv, NODE_ENV: 'development' })).toBe(SECRET);
  });

  it('test auth refuses when Supabase production variables are present', () => {
    expect(() => assertTestAuthAllowed({ ...okEnv, SUPABASE_SERVICE_ROLE_KEY: 'service-role' })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => assertTestAuthAllowed({ ...okEnv, NEXT_PUBLIC_SUPABASE_URL: 'https://abcd.supabase.co' })).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    // Blank values (an unfilled .env line) do not count as set.
    expect(assertTestAuthAllowed({ ...okEnv, SUPABASE_SERVICE_ROLE_KEY: '', NEXT_PUBLIC_SUPABASE_URL: ' ' })).toBe(SECRET);
  });

  it('reads the real process environment by default and refuses there too', async () => {
    vi.stubEnv('ARMADILLO_TEST_AUTH', '1');
    vi.stubEnv('TEST_AUTH_SECRET', SECRET);
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => assertTestAuthAllowed()).toThrow(/production/);
    // Every entry point that touches the session is guarded, not just the explicit check.
    await expect(readTestSession()).rejects.toThrow(/production/);

    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VERCEL', '1');
    expect(() => assertTestAuthAllowed()).toThrow(/VERCEL/);
    await expect(readTestSession()).rejects.toThrow(/VERCEL/);
  });

  it('refuses unless ARMADILLO_TEST_AUTH is exactly 1', () => {
    expect(() => assertTestAuthAllowed({ ...okEnv, ARMADILLO_TEST_AUTH: undefined })).toThrow(/ARMADILLO_TEST_AUTH/);
    expect(() => assertTestAuthAllowed({ ...okEnv, ARMADILLO_TEST_AUTH: 'true' })).toThrow(/ARMADILLO_TEST_AUTH/);
  });

  it('requires TEST_AUTH_SECRET of at least 32 characters', () => {
    expect(() => assertTestAuthAllowed({ ...okEnv, TEST_AUTH_SECRET: undefined })).toThrow(/TEST_AUTH_SECRET/);
    expect(() => assertTestAuthAllowed({ ...okEnv, TEST_AUTH_SECRET: 'x'.repeat(31) })).toThrow(/32/);
    expect(assertTestAuthAllowed({ ...okEnv, TEST_AUTH_SECRET: 'x'.repeat(32) })).toBe('x'.repeat(32));
  });
});

describe('test auth session cookie', () => {
  it('round-trips a signed session', () => {
    const token = signTestSession(USER, SECRET, NOW);
    expect(verifyTestSession(token, SECRET, NOW)).toEqual(USER);
    expect(verifyTestSession(token, SECRET, NOW + (TEST_SESSION_TTL_SECONDS - 1) * 1000)).toEqual(USER);
  });

  it('a tampered cookie is rejected', () => {
    const token = signTestSession(USER, SECRET, NOW);
    const [, , exp, sig] = token.split('.');

    // Swap the user id, the email, or extend the expiry while keeping the original signature.
    expect(verifyTestSession(withPart(token, 0, '00000000-0000-4000-8000-000000000000'), SECRET, NOW)).toBeNull();
    expect(verifyTestSession(withPart(token, 1, b64url('mallory@example.test')), SECRET, NOW)).toBeNull();
    expect(verifyTestSession(withPart(token, 2, String(Number(exp) + 3600)), SECRET, NOW)).toBeNull();

    // Flip one character of the signature.
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect(verifyTestSession(withPart(token, 3, flipped), SECRET, NOW)).toBeNull();
    // Truncated or missing signature.
    expect(verifyTestSession(withPart(token, 3, sig.slice(0, 10)), SECRET, NOW)).toBeNull();
    expect(verifyTestSession(withPart(token, 3, ''), SECRET, NOW)).toBeNull();

    // Signed with a different secret.
    expect(verifyTestSession(signTestSession(USER, 'another-secret-another-secret-0000', NOW), SECRET, NOW)).toBeNull();

    // Malformed shapes.
    for (const bad of ['', 'abc', `${token}.extra`, token.replace(/\./g, ''), `.${token}`]) {
      expect(verifyTestSession(bad, SECRET, NOW)).toBeNull();
    }
    expect(verifyTestSession(undefined, SECRET, NOW)).toBeNull();
  });

  it('an expired cookie is rejected', () => {
    const token = signTestSession(USER, SECRET, NOW);
    expect(verifyTestSession(token, SECRET, NOW + TEST_SESSION_TTL_SECONDS * 1000)).toBeNull();
    expect(verifyTestSession(token, SECRET, NOW + TEST_SESSION_TTL_SECONDS * 1000 + 1)).toBeNull();
  });

  it('a correctly signed token with a non-uuid user id is rejected', () => {
    const forged = signTestSession({ id: 'not-a-uuid', email: USER.email }, SECRET, NOW);
    expect(verifyTestSession(forged, SECRET, NOW)).toBeNull();
  });

  it('emails containing dots round-trip without confusing the token format', () => {
    const user = { id: USER.id, email: 'first.middle.last@sub.example.test' };
    expect(verifyTestSession(signTestSession(user, SECRET, NOW), SECRET, NOW)).toEqual(user);
  });
});
