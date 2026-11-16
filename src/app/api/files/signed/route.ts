import { requireUser } from '@/server/auth';
import { getFileStore, LocalFileStore, verifyLocalDownloadUrl } from '@/server/files/storage';

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const notFound = () => new Response('Not found', { status: 404, headers });

/**
 * GET /api/files/signed?p&exp&n&sig: the download target of LocalFileStore.signDownload (dev/test
 * only; production uses Supabase signed URLs and this route 404s). The URL must carry a valid,
 * unexpired signature AND the caller must be signed in as the owner of the object's prefix.
 */
export async function GET(request: Request) {
  const store = getFileStore();
  if (!(store instanceof LocalFileStore)) return notFound();
  const user = await requireUser();
  const hit = verifyLocalDownloadUrl(new URL(request.url).searchParams);
  if (!hit || !hit.path.startsWith(`${user.id}/`)) return notFound();
  let bytes: Uint8Array;
  try {
    bytes = await store.get(hit.path);
  } catch {
    return notFound();
  }
  const safeName = hit.filename.replace(/[^A-Za-z0-9._-]+/g, '_');
  return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    status: 200,
    headers: {
      ...headers,
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': String(bytes.byteLength),
    },
  });
}
