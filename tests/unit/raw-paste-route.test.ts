// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type P = { slug: string; content: string; language: 'powershell' | 'markdown'; visibility: 'public' | 'unlisted' };
let paste: P | null = null;
vi.mock('@/features/pastebin/service', () => ({ getPaste: async () => paste }));
const { GET } = await import('@/app/(public)/p/[slug]/raw/route');

const get = (slug: string, headers: Record<string, string> = {}, query = '') =>
  GET(new Request(`http://localhost/p/${slug}/raw${query}`, { headers }), { params: Promise.resolve({ slug }) });

beforeEach(() => {
  paste = { slug: 'abcdefgh', content: '<script>alert(1)</script>', language: 'powershell', visibility: 'public' };
});

describe('raw paste route caching', () => {
  it('public content: no-cache (shared caches must revalidate) with a strong ETag', async () => {
    const r = await get('abcdefgh');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-cache');
    expect(r.headers.get('etag')).toMatch(/^"[A-Za-z0-9_-]{16,}"$/);
    expect(await r.text()).toBe(paste!.content);
  });

  it('If-None-Match with the current ETag is a 304 without a body', async () => {
    const etag = (await get('abcdefgh')).headers.get('etag')!;
    const r = await get('abcdefgh', { 'if-none-match': `"other", ${etag}` });
    expect(r.status).toBe(304);
    expect(await r.text()).toBe('');
    expect(r.headers.get('etag')).toBe(etag);
    expect(r.headers.get('cache-control')).toBe('no-cache');
  });

  it('an edited paste gets a new ETag; the download variant has its own', async () => {
    const etag = (await get('abcdefgh')).headers.get('etag')!;
    const download = (await get('abcdefgh', {}, '?download=1')).headers.get('etag')!;
    expect(download).not.toBe(etag);
    paste = { ...paste!, content: 'edited' };
    const r = await get('abcdefgh', { 'if-none-match': etag });
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).not.toBe(etag);
  });

  it('a deleted paste revalidates to 404 no-store', async () => {
    const etag = (await get('abcdefgh')).headers.get('etag')!;
    paste = null;
    const r = await get('abcdefgh', { 'if-none-match': etag });
    expect(r.status).toBe(404);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('unlisted content stays private, no-store, without an ETag or 304', async () => {
    paste = { ...paste!, visibility: 'unlisted' };
    const r = await get('abcdefgh');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('etag')).toBeNull();
    expect((await get('abcdefgh', { 'if-none-match': '*' })).status).toBe(200);
  });
});
