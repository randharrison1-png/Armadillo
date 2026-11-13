import 'server-only';
import type postgres from 'postgres';
import { getPool } from './pool';

/** The transaction handle passed to withUser / withAnon / withService callbacks. */
export type Tx = postgres.TransactionSql;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Role = 'authenticated' | 'anon' | 'service_role';

async function inRole<T>(role: Role, claims: Record<string, string>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const result = await getPool().begin(async (tx) => {
    // Both settings are transaction-local, so nothing leaks to the next user of the connection.
    // `role` is one of three literals above, never caller input.
    await tx.unsafe(`set local role ${role}`);
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    return fn(tx);
  });
  return result as T;
}

/**
 * Runs `fn` in one transaction as role `authenticated` with JWT claims `{ sub: userId }`, so
 * `auth.uid()` is `userId` and RLS enforces ownership. Commits on success, rolls back on throw.
 *
 * `userId` must come from the server-side session (`requireUser()` / `getCurrentUser()`), never
 * from request input.
 */
export function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return Promise.reject(new Error('withUser: userId must be a uuid'));
  }
  return inRole('authenticated', { sub: userId, role: 'authenticated' }, fn);
}

/** Runs `fn` in one transaction as role `anon` (`auth.uid()` is null). Used for public paste reads. */
export function withAnon<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inRole('anon', { role: 'anon' }, fn);
}

/**
 * Runs `fn` as `service_role`, which BYPASSES RLS.
 *
 * ONLY for account export and account deletion (global constraints). Never call it with ids or filters taken from request input without first scoping them to the
 * signed-in user.
 */
export function withService<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inRole('service_role', { role: 'service_role' }, fn);
}
