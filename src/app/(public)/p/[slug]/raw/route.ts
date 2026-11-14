import { extensionFor } from '@/features/pastebin/schema';
import { getPaste } from '@/features/pastebin/service';

const BASE_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  // Belt and braces: even if a browser ignored text/plain, nothing may load or run.
  'Content-Security-Policy': "default-src 'none'; sandbox",
};

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
  return new Response(paste.content, {
    headers: {
      ...BASE_HEADERS,
      'Content-Disposition': download ? `attachment; filename="${filename}"` : 'inline',
      'Cache-Control': unlisted ? 'private, no-store' : 'public, max-age=60',
      ...(unlisted ? { 'X-Robots-Tag': 'noindex' } : {}),
    },
  });
}
