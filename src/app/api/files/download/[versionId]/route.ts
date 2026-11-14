import { requireUser } from '@/server/auth';
import { contentDisposition, encodeForDownload, getVersionFor } from '@/features/library/versioning';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () =>
  new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });

/**
 * GET /api/files/download/<versionId>: the version as the file the user runs on the target image —
 * its stored text in its recorded encoding (BOM included), newlines as stored (encodeForDownload).
 * Served as an opaque attachment: never rendered or sniffed by the browser, never cached.
 * Unknown, malformed or other users' ids are all 404 (RLS hides foreign rows).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const user = await requireUser();
  const { versionId } = await params;
  if (!UUID_RE.test(versionId)) return notFound();
  const found = await getVersionFor(user.id, versionId);
  if (!found) return notFound();
  const bytes = encodeForDownload(found.version);
  return new Response(new Blob([bytes]), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(found.script.filename),
      'Content-Length': String(bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}
