import { afterAll, describe, expect, it } from 'vitest';
import { asAnon, asUser, createTestUser, sql } from './helpers';

afterAll(async () => {
  await sql.end();
});

describe('supabase shim', () => {
  it('auth.uid() returns the claim sub inside asUser and null inside asAnon', async () => {
    const user = await createTestUser();

    const inUser = await asUser(user.id, async (tx) => {
      const [row] = await tx`select auth.uid() as uid, current_user as role`;
      return row;
    });
    expect(inUser.uid).toBe(user.id);
    expect(inUser.role).toBe('authenticated');

    const inAnon = await asAnon(async (tx) => {
      const [row] = await tx`select auth.uid() as uid, current_user as role`;
      return row;
    });
    expect(inAnon.uid).toBeNull();
    expect(inAnon.role).toBe('anon');
  });

  it('auth.jwt() exposes the claims', async () => {
    const user = await createTestUser();
    const claims = await asUser(user.id, async (tx) => {
      const [row] = await tx`select auth.jwt() as claims`;
      return row.claims;
    });
    expect(claims).toMatchObject({ sub: user.id, role: 'authenticated' });
  });

  it('rolls back writes made inside asUser/asAnon', async () => {
    await sql`create table if not exists public.shim_probe (v text)`;
    await sql`grant all on public.shim_probe to anon, authenticated`;
    try {
      const user = await createTestUser();
      await asUser(user.id, (tx) => tx`insert into public.shim_probe (v) values ('u')`);
      await asAnon((tx) => tx`insert into public.shim_probe (v) values ('a')`);
      const [{ n }] = await sql`select count(*)::int as n from public.shim_probe`;
      expect(n).toBe(0);
    } finally {
      await sql`drop table public.shim_probe`;
    }
  });

  it('service_role bypasses RLS and anon/authenticated cannot read auth.users', async () => {
    const [{ rolbypassrls }] = await sql`select rolbypassrls from pg_roles where rolname = 'service_role'`;
    expect(rolbypassrls).toBe(true);
    await expect(asAnon((tx) => tx`select * from auth.users`)).rejects.toThrow(/permission denied/);
  });
});
