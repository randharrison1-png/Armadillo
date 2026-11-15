import { requireUser } from '@/server/auth';
import { createAccountExportLink, ExportTooLargeError } from '@/features/settings/export';

const NO_STORE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (body: unknown, status: number) => Response.json(body, { status, headers: NO_STORE });

// Building and uploading a large archive takes a while.
export const maxDuration = 300;

/**
 * POST /api/account/export: builds the signed-in user's export zip (data/<table>.json, files/<path>,
 * manifest.json; never the Claude key), stores it under their private prefix and answers
 * `{ url, filename }` with a 10 minute signed download URL. Always scoped to the session's user; no
 * id parameter. Errors answer `{ error }` with a user-facing message.
 */
export async function POST() {
  const user = await requireUser();
  try {
    return json(await createAccountExportLink(user.id), 200);
  } catch (e) {
    if (e instanceof ExportTooLargeError) return json({ error: e.message }, 413);
    console.error('[settings] export failed:', e instanceof Error ? e.name : 'unknown');
    return json({ error: 'The export failed. Try again.' }, 500);
  }
}
