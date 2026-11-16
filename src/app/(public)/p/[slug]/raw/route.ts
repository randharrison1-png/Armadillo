import { createHash } from 'node:crypto';
import { extensionFor } from '@/features/pastebin/schema';
import { RAW_PASTE_CSP } from '@/server/security/headers';
import { getPaste } from '@/features/pastebin/service';

const BASE_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  // Belt and braces: even if a browser ignored text/plain, nothing may load or run.
  'Content-Security-Policy': RAW_PASTE_CSP,
};

/** Whether an If-None-Match header lists `etag` (weak comparison, as RFC 9110 specifies for it). */
function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(',').some((t) => {
    const tag = t.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  });
}

/**
 * Public pastes: `Cache-Control: no-cache` with a strong ETag, so browsers and shared caches may
 * keep a copy but must revalidate every time; a deleted paste (e.g. removed for leaking a secret)
 * then revalidates to 404 at once instead of lingering. Unlisted: `private, no-store` (no ETag).
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const paste = await getPaste(slug);
  if (!paste) {
    // Expired, deleted and unknown look the same.
    return new Response('This paste has expired or doesn\'t exist.\n', { status: 404, headers: { ...BASE_HEADERS, 'Cache-Control': 'no-store' } });
  }
  const unlisted = paste.visibility === 'unlisted';
  const download = new URL(request.url).searchParams.get('download') === '1';
  const filename = `${paste.slug}.${extensionFor(paste.language)}`;
  const disposition = download ? `attachment; filename="${filename}"` : 'inline';
  if (unlisted) {
    return new Response(paste.content, {
      headers: { ...BASE_HEADERS, 'Content-Disposition': disposition, 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' },
    });
  }
  const etag = `"${createHash('sha256').update(disposition).update('\0').update(paste.content).digest('base64url')}"`;
  const cacheHeaders = { 'Cache-Control': 'no-cache', ETag: etag };
  if (matches(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: cacheHeaders });
  }
  return new Response(paste.content, { headers: { ...BASE_HEADERS, 'Content-Disposition': disposition, ...cacheHeaders } });
}
