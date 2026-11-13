import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestUser, sql } from './helpers';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { withAnon, withService, withUser } from '@/server/db/withUser';

beforeAll(() => {
  process.env.DATABASE_URL ??= testDatabaseUrl();
});

afterAll(async () => {
  await closePool();
  await sql.end();
});

describe('server data access', () => {
  it('withUser runs as authenticated with the user id as auth.uid()', async () => {
    const user = await createTestUser();
    const row = await withUser(user.id, async (tx) => {
      const [r] = await tx`select current_user as role, auth.uid() as uid, auth.jwt() ->> 'role' as claim_role`;
      return r;
    });
    expect(row).toEqual({ role: 'authenticated', uid: user.id, claim_role: 'authenticated' });
  });

  it('withUser is RLS-scoped and commits its writes', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const seen = await withUser(a.id, async (tx) => {
      await tx`update public.profiles set display_name = 'Committed' where id = ${a.id}`;
      return tx`select id from public.profiles`;
    });
    expect(seen.map((r) => r.id)).toEqual([a.id]);
    expect(seen.map((r) => r.id)).not.toContain(b.id);
    const [row] = await sql`select display_name from public.profiles where id = ${a.id}`;
    expect(row.display_name).toBe('Committed');
  });

  it('withUser rolls back when fn throws', async () => {
    const a = await createTestUser();
    await expect(
      withUser(a.id, async (tx) => {
        await tx`update public.profiles set display_name = 'Rolled back' where id = ${a.id}`;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const [row] = await sql`select display_name from public.profiles where id = ${a.id}`;
    expect(row.display_name).toBeNull();
  });

  it('withUser rejects a user id that is not a uuid', async () => {
    await expect(withUser("x' or '1'='1", async () => 1)).rejects.toThrow(/uuid/i);
    await expect(withUser('', async () => 1)).rejects.toThrow(/uuid/i);
  });

  it('role and claims do not leak to the next transaction on the same pool', async () => {
    const a = await createTestUser();
    await withUser(a.id, async () => undefined);
    const row = await withAnon(async (tx) => {
      const [r] = await tx`select current_user as role, auth.uid() as uid`;
      return r;
    });
    expect(row).toEqual({ role: 'anon', uid: null });
  });

  it('withService bypasses RLS', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const ids = await withService(async (tx) => {
      const [r] = await tx`select current_user as role`;
      expect(r.role).toBe('service_role');
      return (await tx`select id from public.profiles where id in (${a.id}, ${b.id})`).map((x) => x.id);
    });
    expect(ids.sort()).toEqual([a.id, b.id].sort());
  });
});
