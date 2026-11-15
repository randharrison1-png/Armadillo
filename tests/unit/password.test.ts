import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const authMode = vi.fn(() => 'supabase');
const ME = { id: '00000000-0000-4000-8000-000000000001', email: 'a@example.test' };
let supabaseClient: SupabaseClient;
const createSupabaseServerClient = vi.fn(async () => supabaseClient);
const logPasswordChangedFor = vi.fn<(id: string) => Promise<void>>(async () => {});
vi.mock('@/server/auth/supabase', () => ({ createSupabaseServerClient: () => createSupabaseServerClient() }));
vi.mock('@/features/settings/service', async (orig) => ({ ...(await orig<typeof import('@/features/settings/service')>()), logPasswordChangedFor: (id: string) => logPasswordChangedFor(id) }));
vi.mock('@/server/auth', () => ({ authMode: () => authMode(), requireUser: async () => ME }));

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

describe('changePasswordAction under Supabase auth', () => {
  beforeEach(() => {
    authMode.mockReturnValue('supabase');
    logPasswordChangedFor.mockClear();
    createSupabaseServerClient.mockClear();
  });

  it('builds the server client, re-authenticates as the signed-in user, updates, then logs the change', async () => {
    const { client, auth } = fake();
    supabaseClient = client;
    expect(await actions.changePasswordAction('old-password', 'new-password-1')).toEqual({ ok: true });
    expect(createSupabaseServerClient).toHaveBeenCalledTimes(1);
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: ME.email, password: 'old-password' });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'new-password-1' });
    expect(logPasswordChangedFor).toHaveBeenCalledWith(ME.id);
    expect(auth.signInWithPassword.mock.invocationCallOrder[0]).toBeLessThan(auth.updateUser.mock.invocationCallOrder[0]!);
    expect(auth.updateUser.mock.invocationCallOrder[0]).toBeLessThan(logPasswordChangedFor.mock.invocationCallOrder[0]!);
  });

  it('wrong current password: no update, nothing logged', async () => {
    const { client, auth } = fake({ signInWithPassword: vi.fn(async () => ({ data: {}, error: { message: 'Invalid login credentials', code: 'invalid_credentials' } })) });
    supabaseClient = client;
    expect(await actions.changePasswordAction('wrong-password', 'new-password-1')).toMatchObject({ ok: false, code: 'wrong_password' });
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(logPasswordChangedFor).not.toHaveBeenCalled();
  });

  it('a provider failure while updating is reported and not logged', async () => {
    const { client } = fake({ updateUser: vi.fn(async () => ({ data: {}, error: { message: 'x', code: 'unexpected_failure' } })) });
    supabaseClient = client;
    expect(await actions.changePasswordAction('old-password', 'new-password-1')).toMatchObject({ ok: false, code: 'failed' });
    expect(logPasswordChangedFor).not.toHaveBeenCalled();
  });
});
