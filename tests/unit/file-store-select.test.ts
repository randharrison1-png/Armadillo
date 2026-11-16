// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFileStore, LocalFileStore } from '@/server/files/storage';

afterEach(() => vi.unstubAllEnvs());

describe('getFileStore', () => {
  it('uses the local store when LOCAL_FILE_STORE_DIR is set (dev/test)', () => {
    vi.stubEnv('VERCEL', undefined as unknown as string);
    vi.stubEnv('LOCAL_FILE_STORE_DIR', '.tmp/files');
    expect(getFileStore()).toBeInstanceOf(LocalFileStore);
  });

  it('refuses the local disk store on Vercel with a clear message', () => {
    vi.stubEnv('LOCAL_FILE_STORE_DIR', '.tmp/files');
    vi.stubEnv('VERCEL', '1');
    expect(() => getFileStore()).toThrow(/LOCAL_FILE_STORE_DIR.*Vercel/);
  });

  it('a blank LOCAL_FILE_STORE_DIR (as in .env.example) does not select the local store', () => {
    vi.stubEnv('LOCAL_FILE_STORE_DIR', '  ');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-tests');
    expect(getFileStore()).not.toBeInstanceOf(LocalFileStore);
  });

  it('.env.example leaves LOCAL_FILE_STORE_DIR blank', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('.env.example', 'utf8')).toMatch(/^LOCAL_FILE_STORE_DIR=$/m);
  });
});
