import { requireUser } from '@/server/auth';
import { contentDisposition } from '@/features/library/versioning';
import { readEvidenceFileFor } from '@/features/sessions/complete';

const notFound = () =>
  new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });

/**
 * GET /api/files/evidence/<evidenceId>: an evidence file the user attached (execution output, a
 * screenshot, a verification file). Served as an opaque attachment: never rendered or sniffed by the
 * browser (it is untrusted data), never cached. Works for completed sessions too (read-only access).
 * A note-only row, an unknown or malformed id and another user's id (RLS hides the row) are all 404.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ evidenceId: string }> }) {
  const user = await requireUser();
  const { evidenceId } = await params;
  const file = await readEvidenceFileFor(user.id, evidenceId);
  if (!file) return notFound();
  return new Response(new Blob([file.bytes as BlobPart]), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(file.filename),
      'Content-Length': String(file.bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}
