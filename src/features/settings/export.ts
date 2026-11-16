import 'server-only';
import { Zip, ZipDeflate } from 'fflate';
import { withUser } from '@/server/db/withUser';
import { logActivity } from '@/server/activity';
import { getFileStore, type FileStore } from '@/server/files/storage';
import { EXPORT_CONTENT_TYPE, EXPORT_ENTRY_OVERHEAD_BYTES, EXPORT_LINK_TTL_SECONDS, EXPORT_MAX_BYTES } from './schema';

export const EXPORT_FILES_TOO_LARGE = 'files_too_large';

/** The private files are bigger than the in-memory cap. The message is user-facing. */
export class ExportTooLargeError extends Error {
  readonly name = 'ExportTooLargeError';
  readonly code = EXPORT_FILES_TOO_LARGE;
  constructor() {
    super(`Your data and uploaded files are larger than the ${EXPORT_MAX_BYTES / 1024 / 1024} MB this export can hold. Download what you need from each session, or delete files you no longer need.`);
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

/** Where the finished zip is kept (overwritten each time, removed with the rest of the prefix on account deletion). */
export const EXPORT_DIR = '_exports';
export const EXPORT_OBJECT_NAME = 'armadillo-export.zip';

/**
 * The account export: `data/<table>.json` for each owned table (read through withUser, so RLS limits
 * it to the caller; pastes included), `files/<path>` for the caller's private-files objects (never
 * the `_exports/` folder that holds earlier exports), and a `manifest.json`. The profile is read by
 * explicit columns: the key ciphertext is not selectable by the `authenticated` role and is never
 * exported; only the last four characters are.
 *
 * Size: files' stat sizes and the data JSON both count toward `maxBytes` (EXPORT_MAX_BYTES), checked
 * before the zip is built; larger accounts get ExportTooLargeError. Memory: the archive is written
 * with fflate's streaming Zip, one entry at a time, so each file is downloaded, compressed and
 * released before the next; only the compressed output accumulates.
 */
export async function buildAccountExport(
  userId: string,
  store: FileStore = getFileStore(),
  opts: { maxBytes?: number } = {},
): Promise<{ bytes: Uint8Array; filename: string; counts: { tables: Record<string, number>; files: number } }> {
  const maxBytes = opts.maxBytes ?? EXPORT_MAX_BYTES;
  const paths = (await store.list(userId)).filter((p) => !p.startsWith(`${userId}/${EXPORT_DIR}/`));
  let total = 0;
  for (const p of paths) {
    const st = await store.stat(p);
    total += (st?.size ?? 0) + EXPORT_ENTRY_OVERHEAD_BYTES;
    if (total > maxBytes) throw new ExportTooLargeError();
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

  const counts: Record<string, number> = {};
  const dataFiles: [string, Uint8Array][] = [];
  for (const [name, rows] of Object.entries(tables)) {
    const bytes = json(rows);
    total += bytes.byteLength + EXPORT_ENTRY_OVERHEAD_BYTES;
    if (total > maxBytes) throw new ExportTooLargeError();
    dataFiles.push([`data/${name}.json`, bytes]);
    counts[name] = rows.length;
  }

  const exportedAt = new Date();
  const manifest = json({
    exported_at: exportedAt.toISOString(),
    user_id: userId,
    tables: counts,
    files: paths.length,
    note: 'The Claude API key is not included; only its last four characters appear in data/profiles.json.',
  });

  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else chunks.push(chunk);
  });
  const add = (name: string, data: Uint8Array) => {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(data, true);
  };
  for (const [name, bytes] of dataFiles) add(name, bytes);
  add('manifest.json', manifest);
  for (const p of paths) add(`files/${p}`, await store.get(p)); // one file in memory at a time
  zip.end();
  if (failure) throw failure;

  await withUser(userId, (tx) => logActivity(tx, { action: 'account.exported', entityType: 'profile', entityId: userId, meta: { files: paths.length } }));

  const size = chunks.reduce((n, c) => n + c.byteLength, 0);
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { bytes, filename: `armadillo-export-${exportedAt.toISOString().slice(0, 10)}.zip`, counts: { tables: counts, files: paths.length } };
}

/**
 * Builds the export, stores it at private-files/{userId}/_exports/armadillo-export.zip (overwritten
 * each time) and returns a 10 minute signed download URL. The zip is never returned in a response
 * body, so it is not limited by the serverless response size.
 */
export async function createAccountExportLink(
  userId: string,
  store: FileStore = getFileStore(),
  opts: { maxBytes?: number } = {},
): Promise<{ url: string; filename: string }> {
  const { bytes, filename } = await buildAccountExport(userId, store, opts);
  const objectPath = `${userId}/${EXPORT_DIR}/${EXPORT_OBJECT_NAME}`;
  await store.put(objectPath, bytes, EXPORT_CONTENT_TYPE, { upsert: true });
  const url = await store.signDownload(objectPath, { ttlSeconds: EXPORT_LINK_TTL_SECONDS, filename });
  return { url, filename };
}
