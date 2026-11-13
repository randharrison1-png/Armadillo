import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { testDatabaseUrl } from './env';

/** Admin client (superuser). Bypasses RLS; use for setup and for asserting on raw state. */
export const sql = postgres(testDatabaseUrl(), { max: 4, onnotice: () => {} });

type Tx = postgres.TransactionSql;

/** Thrown internally to force a rollback after the callback has returned. */
class Rollback extends Error {}

async function withRole<T>(role: 'authenticated' | 'anon', claims: object, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let result: T;
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
      result = await fn(tx);
      // ROLLBACK, never commit: nothing written inside the callback persists.
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result!;
}

/**
 * Runs `fn` in a transaction as role `authenticated` with JWT claims `{ sub: userId, role }`,
 * so `auth.uid()` returns `userId` and RLS applies.
 * The transaction is ALWAYS ROLLED BACK when `fn` finishes (even on success), so rows written
 * inside `fn` are not visible afterwards. To persist fixtures, use `sql` / `createTestUser`.
 */
export function asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withRole('authenticated', { sub: userId, role: 'authenticated' }, fn);
}

/** Like `asUser` but as role `anon` with no `sub` (`auth.uid()` is null). Always rolled back. */
export function asAnon<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withRole('anon', { role: 'anon' }, fn);
}

/** Inserts a row into auth.users (committed, as admin) and returns it. */
export async function createTestUser(email?: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const address = email ?? `user-${id}@example.test`;
  await sql`insert into auth.users (id, email) values (${id}, ${address})`;
  return { id, email: address };
}
