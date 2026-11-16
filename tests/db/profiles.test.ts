import { afterAll, describe, expect, it } from 'vitest';
import { asAnon, asUser, createTestUser, sql } from './helpers';

afterAll(async () => {
  await sql.end();
});

/** Every profiles column except the ciphertext, which `authenticated` must never read. */
const READABLE = 'id, display_name, default_os, claude_key_last4, model, created_at, updated_at';

describe('profiles', () => {
  it('inserting into auth.users creates a profile row', async () => {
    const user = await createTestUser();
    const rows = await sql`select id, display_name, default_os, claude_key_ciphertext from public.profiles where id = ${user.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: user.id, display_name: null, default_os: null, claude_key_ciphertext: null });
  });

  it('deleting the auth user deletes the profile', async () => {
    const user = await createTestUser();
    await sql`delete from auth.users where id = ${user.id}`;
    const rows = await sql`select 1 from public.profiles where id = ${user.id}`;
    expect(rows).toHaveLength(0);
  });

  it('user A cannot select user B profile', async () => {
    const a = await createTestUser();
    const b = await createTestUser();

    const direct = await asUser(a.id, (tx) => tx.unsafe(`select ${READABLE} from public.profiles where id = $1`, [b.id]));
    expect(direct).toHaveLength(0);

    const all = await asUser(a.id, (tx) => tx.unsafe(`select ${READABLE} from public.profiles`));
    expect(all.map((r) => r.id)).toEqual([a.id]);
  });

  it('authenticated role cannot select claude_key_ciphertext, even on its own row', async () => {
    const a = await createTestUser();
    await sql`update public.profiles set claude_key_ciphertext = 'secret-ciphertext', claude_key_last4 = 'abcd' where id = ${a.id}`;

    await expect(
      asUser(a.id, (tx) => tx`select claude_key_ciphertext from public.profiles where id = ${a.id}`),
    ).rejects.toThrow(/permission denied/);
    await expect(asUser(a.id, (tx) => tx`select * from public.profiles`)).rejects.toThrow(/permission denied/);

    const [own] = await asUser(a.id, (tx) => tx.unsafe(`select ${READABLE} from public.profiles where id = $1`, [a.id]));
    expect(own.claude_key_last4).toBe('abcd');
  });

  it('owner can update their display_name, default_os and model, but not another user row', async () => {
    const a = await createTestUser();
    const b = await createTestUser();

    const updated = await asUser(a.id, async (tx) => {
      const own = await tx`
        update public.profiles set display_name = 'Alice', default_os = 'linux', model = 'claude-test'
        where id = ${a.id} returning id`;
      const other = await tx`update public.profiles set display_name = 'Mallory' where id = ${b.id} returning id`;
      const [row] = await tx`select display_name, default_os, model from public.profiles where id = ${a.id}`;
      return { own: own.length, other: other.length, row };
    });
    expect(updated.own).toBe(1);
    expect(updated.other).toBe(0);
    expect(updated.row).toEqual({ display_name: 'Alice', default_os: 'linux', model: 'claude-test' });

    const [bRow] = await sql`select display_name from public.profiles where id = ${b.id}`;
    expect(bRow.display_name).toBeNull();
  });

  it('default_os only accepts windows, windows_server or linux', async () => {
    const a = await createTestUser();
    await expect(
      asUser(a.id, (tx) => tx`update public.profiles set default_os = 'macos' where id = ${a.id}`),
    ).rejects.toThrow(/invalid input value for enum/);
  });

  it('authenticated cannot write the key columns, change its id, insert or delete', async () => {
    const a = await createTestUser();
    const stranger = crypto.randomUUID();
    await expect(
      asUser(a.id, (tx) => tx`update public.profiles set claude_key_ciphertext = 'x' where id = ${a.id}`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(a.id, (tx) => tx`update public.profiles set claude_key_last4 = 'wxyz' where id = ${a.id}`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(a.id, (tx) => tx`update public.profiles set id = ${stranger} where id = ${a.id}`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(stranger, (tx) => tx`insert into public.profiles (id) values (${stranger})`),
    ).rejects.toThrow(/permission denied/);
    await expect(asUser(a.id, (tx) => tx`delete from public.profiles where id = ${a.id}`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('anon cannot read profiles at all', async () => {
    await createTestUser();
    await expect(asAnon((tx) => tx`select id from public.profiles`)).rejects.toThrow(/permission denied/);
  });

  it('the new-user trigger function cannot be called by API roles', async () => {
    const [{ anon, authed }] = await sql`
      select has_function_privilege('anon', 'public.handle_new_user()', 'execute') as anon,
             has_function_privilege('authenticated', 'public.handle_new_user()', 'execute') as authed`;
    expect(anon).toBe(false);
    expect(authed).toBe(false);
  });
});
