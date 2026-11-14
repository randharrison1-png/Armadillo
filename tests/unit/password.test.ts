import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const authMode = vi.fn(() => 'supabase');
vi.mock('@/server/auth', () => ({ authMode: () => authMode(), requireUser: async () => ({ id: '00000000-0000-4000-8000-000000000001', email: 'a@example.test' }) }));

const { changePassword } = await import('@/server/auth/password');
const actions = await import('@/features/settings/actions');

type Fake = { signInWithPassword: ReturnType<typeof vi.fn>; updateUser: ReturnType<typeof vi.fn> };
const fake = (over: Partial<Fake> = {}): { client: SupabaseClient; auth: Fake } => {
  const auth: Fake = {
    signInWithPassword: vi.fn(async () => ({ data: {}, error: null })),
    updateUser: vi.fn(async () => ({ data: {}, error: null })),
    ...over,
  };
  return { client: { auth } as unknown as SupabaseClient, auth };
};

describe('changePassword (Supabase)', () => {
  it('re-authenticates with the current password, then updates', async () => {
    const { client, auth } = fake();
    expect(await changePassword(client, { email: 'a@example.test', current: 'old-password', next: 'new-password-1' })).toEqual({ ok: true });
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'a@example.test', password: 'old-password' });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'new-password-1' });
    expect(auth.signInWithPassword.mock.invocationCallOrder[0]).toBeLessThan(auth.updateUser.mock.invocationCallOrder[0]!);
  });

  it('wrong current password: no update', async () => {
    const { client, auth } = fake({ signInWithPassword: vi.fn(async () => ({ data: {}, error: { message: 'Invalid login credentials', code: 'invalid_credentials' } })) });
    const r = await changePassword(client, { email: 'a@example.test', current: 'nope-nope', next: 'new-password-1' });
    expect(r).toMatchObject({ ok: false, code: 'wrong_password' });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('weak new password is reported with the provider message', async () => {
    const { client } = fake({ updateUser: vi.fn(async () => ({ data: {}, error: { message: 'Password is too weak', code: 'weak_password' } })) });
    expect(await changePassword(client, { email: 'a@example.test', current: 'old-password', next: 'password1' })).toMatchObject({ ok: false, code: 'weak_password', error: 'Password is too weak' });
  });

  it('other update failures are generic', async () => {
    const { client } = fake({ updateUser: vi.fn(async () => ({ data: {}, error: { message: 'boom internals', code: 'unexpected_failure' } })) });
    const r = await changePassword(client, { email: 'a@example.test', current: 'old-password', next: 'new-password-1' });
    expect(r).toMatchObject({ ok: false, code: 'failed' });
    expect(JSON.stringify(r)).not.toContain('internals');
  });

  it('rejects a too-short new password before calling the provider', async () => {
    const { client, auth } = fake();
    expect(await changePassword(client, { email: 'a@example.test', current: 'old-password', next: 'short' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('rejects an unchanged password', async () => {
    const { client } = fake();
    expect(await changePassword(client, { email: 'a@example.test', current: 'same-password', next: 'same-password' })).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('changePasswordAction', () => {
  beforeEach(() => authMode.mockReturnValue('test'));

  it("returns { code: 'unsupported' } under the test auth provider", async () => {
    expect(await actions.changePasswordAction('old-password', 'new-password-1')).toMatchObject({ ok: false, code: 'unsupported' });
  });
});
