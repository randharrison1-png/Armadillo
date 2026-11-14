import 'server-only';
import { zipSync } from 'fflate';
import { withUser } from '@/server/db/withUser';
import { logActivity } from '@/server/activity';
import { getFileStore, type FileStore } from '@/server/files/storage';
import { EXPORT_MAX_FILE_BYTES } from './schema';

export const EXPORT_FILES_TOO_LARGE = 'files_too_large';

/** The private files are bigger than the in-memory cap. The message is user-facing. */
export class ExportTooLargeError extends Error {
  readonly name = 'ExportTooLargeError';
  readonly code = EXPORT_FILES_TOO_LARGE;
  constructor() {
    super(`Your uploaded files are larger than the ${EXPORT_MAX_FILE_BYTES / 1024 / 1024} MB this export can hold. Download what you need from each session, or delete files you no longer need.`);
  }
}

/** Owned tables, in the order they appear in the archive. Every one has `owner_id`; RLS scopes the reads to the caller. */
const OWNED_TABLES = [
  'sessions', 'scripts', 'script_versions', 'readmes', 'conversations', 'messages', 'leads_reports',
  'requirements', 'leads_findings', 'proposals', 'evidence', 'remediation_cycles', 'workflow_steps',
  'workflow_step_events', 'forensic_questions', 'activity_log',
] as const;

const enc = new TextEncoder();
const json = (v: unknown) => enc.encode(JSON.stringify(v, null, 2));

/**
 * The account export: `data/<table>.json` for each owned table (read through withUser, so RLS limits
 * it to the caller; pastes included), `files/<path>` for the caller's private-files objects, and a
 * `manifest.json`. The profile is read by explicit columns — the key ciphertext is not selectable by
 * the `authenticated` role and is never exported; only the last four characters are.
 *
 * Built in memory: the files' total size is capped at EXPORT_MAX_FILE_BYTES (checked with stat before
 * anything is downloaded) and larger accounts get ExportTooLargeError.
 */
export async function buildAccountExport(
  userId: string,
  store: FileStore = getFileStore(),
): Promise<{ bytes: Uint8Array; filename: string; counts: { tables: Record<string, number>; files: number } }> {
  const paths = await store.list(userId);
  let total = 0;
  for (const p of paths) {
    const st = await store.stat(p);
    total += st?.size ?? 0;
    if (total > EXPORT_MAX_FILE_BYTES) throw new ExportTooLargeError();
  }

  const tables: Record<string, unknown[]> = await withUser(userId, async (tx) => {
    const out: Record<string, unknown[]> = {};
    out.profiles = (await tx<{ r: unknown }[]>`
      select to_jsonb(p) as r from (
        select id, display_name, default_os, claude_key_last4, model, created_at, updated_at
        from public.profiles where id = ${userId}
      ) p`).map((x) => x.r);
    for (const t of OWNED_TABLES) {
      // `t` comes from the constant list above, never from input.
      out[t] = (await tx.unsafe<{ r: unknown }[]>(`select to_jsonb(t) as r from public.${t} t where owner_id = $1 order by id`, [userId])).map((x) => x.r);
    }
    out.pastes = (await tx<{ r: unknown }[]>`select to_jsonb(p) as r from paste.pastes p where owner_id = ${userId} order by created_at, id`).map((x) => x.r);
    return out;
  });

  const archive: Record<string, Uint8Array> = {};
  const counts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(tables)) {
    archive[`data/${name}.json`] = json(rows);
    counts[name] = rows.length;
  }
  for (const p of paths) archive[`files/${p}`] = await store.get(p);
  const exportedAt = new Date();
  archive['manifest.json'] = json({
    exported_at: exportedAt.toISOString(),
    user_id: userId,
    tables: counts,
    files: paths.length,
    note: 'The Claude API key is not included; only its last four characters appear in data/profiles.json.',
  });

  await withUser(userId, (tx) => logActivity(tx, { action: 'account.exported', entityType: 'profile', entityId: userId, meta: { files: paths.length } }));

  return {
    // Files are already compressed or small text; level 6 keeps the text tables small.
    bytes: zipSync(archive, { level: 6 }),
    filename: `armadillo-export-${exportedAt.toISOString().slice(0, 10)}.zip`,
    counts: { tables: counts, files: paths.length },
  };
}
