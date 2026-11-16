// @vitest-environment node
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'a@example.com' };
const OTHER = '22222222-2222-4222-8222-222222222222';
let current: typeof USER | null = USER;
vi.mock('@/server/auth', () => ({
  getCurrentUser: async () => current,
  requireUser: async () => {
    if (!current) throw new Error('redirect:/login');
    return current;
  },
}));

import { ForbiddenFileError, LocalFileStore, buildStoragePath, createUploadTarget, readPrivate, sanitizeFilename, uploadPrivate, verifyStoredUpload } from '@/server/files/storage';
import { FileTooLargeError, UnsupportedFileTypeError } from '@/server/files/limits';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arm-files-'));
  process.env.LOCAL_FILE_STORE_DIR = dir;
  current = USER;
});
afterEach(() => {
  delete process.env.LOCAL_FILE_STORE_DIR;
});

describe('LocalFileStore', () => {
  it('round-trips bytes and removes a prefix', async () => {
    const s = new LocalFileStore(dir);
    await s.put('u1/lib/a.txt', new Uint8Array([1, 2, 3]), 'text/plain');
    await s.put('u1/lib/b.txt', new Uint8Array([4]), 'text/plain');
    expect([...(await s.get('u1/lib/a.txt'))]).toEqual([1, 2, 3]);
    await s.removePrefix('u1');
    await expect(s.get('u1/lib/a.txt')).rejects.toThrow();
    expect(existsSync(join(dir, 'u1'))).toBe(false);
  });

  it.each(['../evil', 'a/../../evil', '/etc/passwd', 'a\\b', '', 'a//b', './a', 'a/./b', 'a\0b'])('rejects unsafe path %j', async (p) => {
    const s = new LocalFileStore(dir);
    await expect(s.put(p, new Uint8Array([1]), 'text/plain')).rejects.toThrow(/invalid storage path/i);
    await expect(s.get(p)).rejects.toThrow(/invalid storage path/i);
    await expect(s.removePrefix(p)).rejects.toThrow(/invalid storage path/i);
  });
});

describe('paths and uploads', () => {
  it('sanitizes filenames', () => {
    expect(sanitizeFilename('../../etc/pass wd.PS1')).toBe('pass_wd.PS1');
    expect(sanitizeFilename('C:\\x\\run me!.sh')).toBe('run_me_.sh');
    expect(sanitizeFilename('...')).toBe('file');
  });

  it('builds {owner}/{session|library}/{uuid}-{name}', () => {
    expect(buildStoragePath(USER.id, undefined, 'a b.txt')).toMatch(new RegExp(`^${USER.id}/library/[0-9a-f-]{36}-a_b\\.txt$`));
    expect(buildStoragePath(USER.id, OTHER, 'a.txt')).toMatch(new RegExp(`^${USER.id}/${OTHER}/`));
    expect(() => buildStoragePath(USER.id, '../x', 'a.txt')).toThrow();
  });

  it('uploadPrivate stores under the signed-in owner and validates', async () => {
    const f = new File([new Uint8Array([104, 105])], 'hi.txt', { type: 'text/plain' });
    const { storagePath } = await uploadPrivate(f, { kind: 'readme', sessionId: OTHER });
    expect(storagePath.startsWith(`${USER.id}/${OTHER}/`)).toBe(true);
    expect([...(await readPrivate(storagePath))]).toEqual([104, 105]);
    await expect(uploadPrivate(new File([new Uint8Array(1)], 'a.exe'), { kind: 'script' })).rejects.toBeInstanceOf(UnsupportedFileTypeError);
    await expect(uploadPrivate(new File([new Uint8Array(3 * 1024 * 1024)], 'a.txt'), { kind: 'script' })).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it('readPrivate refuses another owner and unsafe paths', async () => {
    const { storagePath } = await uploadPrivate(new File([new Uint8Array([1])], 'a.txt'), { kind: 'script' });
    current = { id: OTHER, email: 'b@example.com' };
    await expect(readPrivate(storagePath)).rejects.toThrow(/forbidden/i);
    current = USER;
    await expect(readPrivate(`${USER.id}/../${OTHER}/x`)).rejects.toThrow();
    await expect(readPrivate(`${USER.id}x/library/a`)).rejects.toThrow(/forbidden/i);
  });

  it('createUploadTarget returns a local target in dev/test and validates', async () => {
    const t = await createUploadTarget({ kind: 'report', sessionId: OTHER }, 'out.log', 100);
    expect(t.kind).toBe('local');
    if (t.kind === 'local') expect(t.url).toBe('/api/files/upload');
    await expect(createUploadTarget({ kind: 'report' }, 'x.exe', 1)).rejects.toBeInstanceOf(UnsupportedFileTypeError);
  });
});

describe('uploadWithRetry', () => {
  it('retries transient failures with backoff, not 4xx', async () => {
    const { uploadWithRetry } = await import('@/lib/files/uploadClient');
    const file = new File([new Uint8Array([1])], 'a.txt');
    const target = { kind: 'supabase-signed', signedUrl: 'https://x/y?token=t', token: 't', storagePath: 'u/library/a' } as const;
    const delays: number[] = [];
    const sleep = async (ms: number) => void delays.push(ms);
    const ok = new Response('{}', { status: 200 });
    let n = 0;
    const flaky = (async () => (++n < 3 ? new Response('', { status: 503 }) : ok)) as unknown as typeof fetch;
    await expect(uploadWithRetry(file, target, { fetchImpl: flaky, sleep })).resolves.toEqual({ storagePath: 'u/library/a' });
    expect(n).toBe(3);
    expect(delays).toEqual([500, 1000]);
    // Lost response: first PUT stored the file, the retry gets 409 (object exists) -> still success.
    let m = 0;
    const lost = (async () => {
      if (++m === 1) throw new TypeError('connection reset');
      return new Response('', { status: 409 });
    }) as unknown as typeof fetch;
    await expect(uploadWithRetry(file, target, { fetchImpl: lost, sleep })).resolves.toEqual({ storagePath: 'u/library/a' });
    const bad = (async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    await expect(uploadWithRetry(file, target, { fetchImpl: bad, sleep })).rejects.toThrow(/rejected \(403\)/);
    const down = (async () => { throw new TypeError('network'); }) as unknown as typeof fetch;
    await expect(uploadWithRetry(file, target, { fetchImpl: down, sleep })).rejects.toThrow(/after 3 attempts/);
  });
});

describe('retry idempotency and verifyStoredUpload', () => {
  it('local retries reuse the same storage path (no orphans)', async () => {
    const f = () => new File([new Uint8Array([1])], 'a.txt');
    const t = await createUploadTarget({ kind: 'script' }, 'a.txt', 1);
    const one = await uploadPrivate(f(), { kind: 'script' }, { storagePath: t.storagePath });
    const two = await uploadPrivate(f(), { kind: 'script' }, { storagePath: t.storagePath });
    expect(one.storagePath).toBe(t.storagePath);
    expect(two.storagePath).toBe(t.storagePath);
    await expect(uploadPrivate(f(), { kind: 'script' }, { storagePath: `${OTHER}/library/${'a'.repeat(8)}-a.txt` })).rejects.toThrow(/invalid storage path/i);
    await expect(uploadPrivate(f(), { kind: 'script' }, { storagePath: t.storagePath.replace('a.txt', 'b.txt') })).rejects.toThrow(/invalid storage path/i);
  });

  const put = (p: string, n: number) => new LocalFileStore(dir).put(p, new Uint8Array(n), 'application/octet-stream');
  const uuid = '33333333-3333-4333-8333-333333333333';

  it('accepts a stored file within limits', async () => {
    await put(`${USER.id}/library/${uuid}-a.log`, 10);
    await expect(verifyStoredUpload(`${USER.id}/library/${uuid}-a.log`, 'report')).resolves.toEqual({ size: 10 });
  });
  it('rejects oversize stored files (actual size, not declared)', async () => {
    await put(`${USER.id}/library/${uuid}-a.ps1`, 2 * 1024 * 1024 + 1);
    await expect(verifyStoredUpload(`${USER.id}/library/${uuid}-a.ps1`, 'script')).rejects.toBeInstanceOf(FileTooLargeError);
  });
  it('rejects wrong owner, bad extension, and missing objects', async () => {
    await put(`${OTHER}/library/${uuid}-a.txt`, 1);
    await expect(verifyStoredUpload(`${OTHER}/library/${uuid}-a.txt`, 'script')).rejects.toBeInstanceOf(ForbiddenFileError);
    await put(`${USER.id}/library/${uuid}-a.exe`, 1);
    await expect(verifyStoredUpload(`${USER.id}/library/${uuid}-a.exe`, 'script')).rejects.toBeInstanceOf(UnsupportedFileTypeError);
    await expect(verifyStoredUpload(`${USER.id}/library/${uuid}-missing.txt`, 'script')).rejects.toThrow(/not found/i);
  });
});
