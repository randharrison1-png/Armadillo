import { requireUser } from '@/server/auth';
import { buildAccountExport, ExportTooLargeError } from '@/features/settings/export';

const NO_STORE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

/**
 * GET /api/account/export: the signed-in user's data as a zip (data/<table>.json, files/<path>,
 * manifest.json; never the Claude key). Always scoped to the session's user; there is no id parameter.
 */
export async function GET() {
  const user = await requireUser();
  try {
    const { bytes, filename } = await buildAccountExport(user.id);
    return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), {
      status: 200,
      headers: {
        ...NO_STORE,
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(bytes.byteLength),
      },
    });
  } catch (e) {
    if (e instanceof ExportTooLargeError) return new Response(e.message, { status: 413, headers: NO_STORE });
    console.error('[settings] export failed:', e instanceof Error ? e.name : 'unknown');
    return new Response('The export failed. Try again.', { status: 500, headers: NO_STORE });
  }
}
