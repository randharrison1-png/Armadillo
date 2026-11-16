import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/auth', () => ({ requireUser: async () => ({ id: 'u', email: 'u@example.test' }) }));
const { LocalFileStore, SupabaseFileStore, verifyLocalDownloadUrl } = await import('@/server/files/storage');

const SECRET = 'unit-test-signing-secret-0123456789abcdef';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  vi.useRealTimers();
});
const tmp = async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'armadillo-sign-'));
  dirs.push(d);
  return d;
};

describe('LocalFileStore signed downloads', () => {
  it('signs a path with a 10 minute expiry and verifies it', async () => {
    const s = new LocalFileStore(await tmp(), SECRET);
    const url = await s.signDownload('u1/_exports/a.zip', { ttlSeconds: 600, filename: 'a.zip' });
    const q = new URL(url, 'http://x');
    expect(q.pathname).toBe('/api/files/signed');
    expect(verifyLocalDownloadUrl(q.searchParams, SECRET)).toEqual({ path: 'u1/_exports/a.zip', filename: 'a.zip' });
  });

  it('rejects tampering, another secret and expiry', async () => {
    const s = new LocalFileStore(await tmp(), SECRET);
    const q = new URL(await s.signDownload('u1/_exports/a.zip', { ttlSeconds: 600, filename: 'a.zip' }), 'http://x');
    const tampered = new URLSearchParams(q.searchParams);
    tampered.set('p', 'u2/_exports/a.zip');
    expect(verifyLocalDownloadUrl(tampered, SECRET)).toBeNull();
    const renamed = new URLSearchParams(q.searchParams);
    renamed.set('n', 'evil.html');
    expect(verifyLocalDownloadUrl(renamed, SECRET)).toBeNull();
    expect(verifyLocalDownloadUrl(q.searchParams, 'another-secret-another-secret-0123456')).toBeNull();
    expect(verifyLocalDownloadUrl(q.searchParams, SECRET, Date.now() + 601_000)).toBeNull();
    expect(verifyLocalDownloadUrl(new URLSearchParams(), SECRET)).toBeNull();
  });
});

describe('SupabaseFileStore', () => {
  const fake = () => {
    const bucket = {
      upload: vi.fn(async () => ({ error: null })),
      createSignedUrl: vi.fn(async () => ({ data: { signedUrl: 'https://x.supabase.co/storage/v1/object/sign/private-files/u1/_exports/a.zip?token=t' }, error: null })),
    };
    const client = { storage: { from: vi.fn(() => bucket) } } as unknown as SupabaseClient;
    return { client, bucket };
  };

  it('put can overwrite (upsert) and defaults to no overwrite', async () => {
    const { client, bucket } = fake();
    const s = new SupabaseFileStore(client);
    await s.put('u1/_exports/a.zip', new Uint8Array(1), 'application/zip', { upsert: true });
    expect(bucket.upload).toHaveBeenLastCalledWith('u1/_exports/a.zip', expect.anything(), { contentType: 'application/zip', upsert: true });
    await s.put('u1/library/b.txt', new Uint8Array(1), 'text/plain');
    expect(bucket.upload).toHaveBeenLastCalledWith('u1/library/b.txt', expect.anything(), { contentType: 'text/plain', upsert: false });
  });

  it('signDownload asks Supabase for a 10 minute URL that downloads under the given name', async () => {
    const { client, bucket } = fake();
    const url = await new SupabaseFileStore(client).signDownload('u1/_exports/a.zip', { ttlSeconds: 600, filename: 'a.zip' });
    expect(bucket.createSignedUrl).toHaveBeenCalledWith('u1/_exports/a.zip', 600, { download: 'a.zip' });
    expect(url).toContain('token=t');
  });
});
