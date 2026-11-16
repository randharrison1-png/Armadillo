import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileStore } from '@/server/files/storage';

const deleteUser = vi.fn();
const createClient = vi.fn(() => ({ auth: { admin: { deleteUser } } }));
vi.mock('@supabase/supabase-js', () => ({ createClient: (...a: unknown[]) => (createClient as (...x: unknown[]) => unknown)(...a) }));
vi.mock('@/server/auth', () => ({ authMode: () => 'supabase', requireUser: async () => ({ id: 'u', email: 'u@example.test' }) }));

const { deleteAccountFor, AccountDeletionError } = await import('@/features/settings/deleteAccount');

const USER = '11111111-1111-4111-8111-111111111111';
const memoryStore = () => {
  const objects = new Set([`${USER}/library/a.txt`]);
  const removePrefix = vi.fn(async () => objects.clear());
  const store = { removePrefix, list: vi.fn(async () => [...objects]) } as unknown as FileStore;
  return { store, removePrefix, objects };
};

beforeEach(() => {
  deleteUser.mockReset().mockResolvedValue({ data: {}, error: null });
  createClient.mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-for-tests';
});

describe('deleteAccountFor with Supabase Auth (production path)', () => {
  it('hard-deletes the auth user through the admin API after the files are gone', async () => {
    const { store, removePrefix } = memoryStore();
    await deleteAccountFor(USER, { store });
    expect(removePrefix).toHaveBeenCalledWith(USER);
    expect(deleteUser).toHaveBeenCalledTimes(1);
    // Exactly (userId): no second argument, so no shouldSoftDelete — the row and its cascade really go.
    expect(deleteUser.mock.calls[0]).toEqual([USER]);
    expect(removePrefix.mock.invocationCallOrder[0]).toBeLessThan(deleteUser.mock.invocationCallOrder[0]!);
    expect(createClient).toHaveBeenCalledWith('https://example.supabase.co', 'service-role-key-for-tests', expect.anything());
  });

  it('an { error } result becomes AccountDeletionError at the account stage', async () => {
    deleteUser.mockResolvedValue({ data: null, error: { message: 'database error deleting user' } });
    const { store } = memoryStore();
    await expect(deleteAccountFor(USER, { store })).rejects.toMatchObject({ name: 'AccountDeletionError', stage: 'account' });
  });

  it('missing Supabase env fails at the account stage after the files are removed', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { store, removePrefix, objects } = memoryStore();
    const err = await deleteAccountFor(USER, { store }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountDeletionError);
    expect(err).toMatchObject({ stage: 'account' });
    expect(removePrefix).toHaveBeenCalled();
    expect(objects.size).toBe(0);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('files failing first never reaches the admin API', async () => {
    const store = { removePrefix: vi.fn(async () => { throw new Error('down'); }), list: vi.fn(async () => []) } as unknown as FileStore;
    await expect(deleteAccountFor(USER, { store })).rejects.toMatchObject({ stage: 'files' });
    expect(deleteUser).not.toHaveBeenCalled();
  });
});
