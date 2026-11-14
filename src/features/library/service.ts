import 'server-only';
import { createHash } from 'node:crypto';
import { logActivity } from '@/server/activity';
import { withUser, type Tx } from '@/server/db/withUser';
import { decodeText } from '@/server/files/encoding';
import type { Script, ScriptCategory, ScriptLanguage, ScriptVersion } from '@/lib/types';
import type { LibraryQuery } from './filters';
import { createScriptSchema, NAME_MAX, type CreateScriptInput, type ScriptMeta } from './schema';
import { defaultFormat, languageFor, type TextFormat } from './scriptMeta';

/** A script row plus the number of its current version (for "v3" in the table). */
export type ScriptListItem = Script & { current_version_no: number | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** sha256 of a stored version: SHA-256 over the UTF-8 encoding of its content string (not the file bytes). */
export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const eol = { crlf: '\r\n', lf: '\n', mixed: '\n' } as const;

/** Escapes LIKE wildcards so user text is matched literally (backslash is ILIKE's default escape). */
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Most rows the table shows; the page tells the user when a result was cut off. */
export const LIBRARY_LIMIT = 200;

/**
 * The search query as a composable fragment (exported so tests can EXPLAIN it). Every
 * whitespace-separated term must match, case-insensitively, name, filename, description or the
 * CURRENT version's content. Each term is `s.id in (metadata matches UNION content matches)`: the
 * content branch is a plain `ilike` on script_versions.content, so it can use the trigram GIN
 * index (an OR across the two tables could not). Category/function/scope are plain WHERE clauses.
 */
export function searchQuery(tx: Tx, q: LibraryQuery, limit = LIBRARY_LIMIT) {
  const terms = (q.text ?? '').split(/\s+/).filter(Boolean);
  const termMatch = (t: string) => {
    const p = likePattern(t);
    return tx`s.id in (
      select m.id from public.scripts m
        where m.name ilike ${p} or m.filename ilike ${p} or m.description ilike ${p}
      union
      select c.id from public.scripts c
        join public.script_versions v on v.id = c.current_version_id
        where v.content ilike ${p})`;
  };
  const scope = q.scope ?? 'universal';
  let where = tx`s.archived_at is null`;
  if (scope === 'universal') where = tx`${where} and s.session_id is null`;
  else if (scope === 'session') where = tx`${where} and s.session_id is not null`;
  if (q.category) where = tx`${where} and s.category = ${q.category}::public.script_category`;
  if (q.fn) where = tx`${where} and s.function = ${q.fn}::public.script_function`;
  where = terms.reduce((acc, t) => tx`${acc} and ${termMatch(t)}`, where);
  return tx`
    select s.*, v.version_no as current_version_no
    from public.scripts s
    left join public.script_versions v on v.id = s.current_version_id
    where ${where}
    order by s.updated_at desc, s.created_at desc, s.id
    limit ${limit}`;
}

/** The user's non-archived scripts matching `q`, newest first, at most `limit` (default LIBRARY_LIMIT). */
export function searchScriptsFor(userId: string, q: LibraryQuery, limit = LIBRARY_LIMIT): Promise<ScriptListItem[]> {
  return withUser(userId, (tx) => searchQuery(tx, q, limit) as unknown as Promise<ScriptListItem[]>);
}

/** Sidebar numbers: universal, non-archived scripts per category (one grouped query, no row fetch). */
export function libraryCountsFor(userId: string): Promise<Partial<Record<ScriptCategory, number>>> {
  return withUser(userId, async (tx) => {
    const rows = await tx<{ category: ScriptCategory; n: number }[]>`
      select category, count(*)::int as n from public.scripts
      where session_id is null and archived_at is null group by category`;
    return Object.fromEntries(rows.map((r) => [r.category, r.n]));
  });
}

/** One script with its current version (content included), or null (missing, malformed id, or not yours). */
export function getScriptWithContentFor(userId: string, scriptId: string): Promise<{ script: Script; version: ScriptVersion } | null> {
  if (!UUID_RE.test(scriptId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const [script] = await tx<Script[]>`select * from public.scripts where id = ${scriptId}`;
    if (!script?.current_version_id) return null;
    const [version] = await tx<ScriptVersion[]>`select * from public.script_versions where id = ${script.current_version_id}`;
    return version ? { script, version } : null;
  });
}

type NewScript = {
  name: string;
  filename: string;
  category: Script['category'];
  fn: Script['function'];
  description?: string | null;
  osCompat: Script['os_compat'];
  content: string;
  format: TextFormat;
  /** Provenance: the version this one was copied from. */
  baseVersionId?: string | null;
  changeNote?: string | null;
  sha256?: string;
  /** Defaults to languageFor(filename). */
  language?: ScriptLanguage;
  /** Session-scoped script (null/undefined ⇒ universal). */
  sessionId?: string | null;
  forkedFromVersionId?: string | null;
  /** Who wrote version 1 (default 'user'). 'claude' only for a session script (an accepted remediation). */
  author?: 'user' | 'claude';
  activity: { action: string; meta?: Record<string, unknown> };
};

/** Script row + version 1 + current_version_id + activity entry, inside the caller's transaction. */
export async function insertScriptWithV1(tx: Tx, n: NewScript): Promise<Script> {
  // Claude never writes universal scripts (spec §5.1: the library source is never silently overwritten).
  if (n.author === 'claude' && !n.sessionId) throw new Error('Claude can only write session scripts');
  const [row] = await tx<Script[]>`
    insert into public.scripts (name, filename, category, function, description, os_compat, session_id, forked_from_version_id)
    values (${n.name}, ${n.filename}, ${n.category}::public.script_category, ${n.fn}::public.script_function,
            ${n.description ?? null}, ${n.osCompat as string[]}::public.os_type[], ${n.sessionId ?? null},
            ${n.forkedFromVersionId ?? null})
    returning *`;
  const [version] = await tx<{ id: string }[]>`
    insert into public.script_versions
      (script_id, version_no, content, encoding, line_ending, language, sha256, author, change_note, base_version_id)
    values (${row!.id}, 1, ${n.content}, ${n.format.encoding}::public.text_encoding, ${n.format.lineEnding},
            ${n.language ?? languageFor(n.filename)}::public.script_language, ${n.sha256 ?? sha256Hex(n.content)}, ${n.author ?? 'user'},
            ${n.changeNote ?? null}, ${n.baseVersionId ?? null})
    returning id`;
  const [script] = await tx<Script[]>`
    update public.scripts set current_version_id = ${version!.id}, updated_at = now() where id = ${row!.id} returning *`;
  await logActivity(tx, {
    action: n.activity.action,
    entityType: 'script',
    entityId: script!.id,
    ...(n.sessionId ? { sessionId: n.sessionId } : {}),
    meta: { name: script!.name, filename: script!.filename, versionId: version!.id, ...n.activity.meta },
  });
  return script!;
}

/**
 * Creates a universal library script at version 1 (author 'user'). Uploads pass the `format`
 * detected from the file's bytes; scripts written in the app get per-extension defaults and their
 * newlines normalized to that line ending, so the stored text always agrees with `line_ending`.
 */
export async function createScriptFor(
  userId: string,
  input: CreateScriptInput & { format?: TextFormat },
  activity: { action: string; meta?: Record<string, unknown> } = { action: 'script.create' },
): Promise<Script> {
  const { format: given, ...rest } = input;
  const data = createScriptSchema.parse(rest);
  const format = given ?? defaultFormat(data.filename);
  const content = given ? data.content : data.content.replace(/\r\n|\r|\n/g, eol[format.lineEnding]);
  return withUser(userId, (tx) =>
    insertScriptWithV1(tx, { ...data, content, format, changeNote: given ? 'Uploaded' : 'Created', activity }),
  );
}

/**
 * The upload path after the bytes are read back from storage: decode (encoding + line ending
 * detected from the bytes, BOM removed), then store the decoded text verbatim as v1. Download
 * (encodeForDownload) re-applies exactly that encoding (ANSI/Windows-1252 included), so the file
 * round-trips byte for byte.
 */
export function createScriptFromUploadFor(
  userId: string,
  meta: ScriptMeta,
  bytes: Uint8Array,
  activityMeta: Record<string, unknown> = {},
): Promise<Script> {
  const decoded = decodeText(bytes);
  return createScriptFor(
    userId,
    { ...meta, content: decoded.text, format: { encoding: decoded.encoding, lineEnding: decoded.lineEnding } },
    { action: 'script.upload', meta: { ...activityMeta, encoding: decoded.encoding } },
  );
}

/** "Copy": a new universal script at v1 from the source's current version; the source is untouched. */
export function duplicateScriptFor(userId: string, scriptId: string): Promise<Script> {
  return withUser(userId, async (tx) => {
    const [src] = UUID_RE.test(scriptId) ? await tx<Script[]>`select * from public.scripts where id = ${scriptId}` : [];
    const [v] = src?.current_version_id
      ? await tx<ScriptVersion[]>`select * from public.script_versions where id = ${src.current_version_id}`
      : [];
    if (!src || !v) throw new Error('Script not found');
    const suffix = ' (copy)';
    return insertScriptWithV1(tx, {
      name: src.name.slice(0, NAME_MAX - suffix.length) + suffix,
      filename: src.filename,
      category: src.category,
      fn: src.function === 'session_generated' ? 'universal_hardening' : src.function,
      description: src.description,
      osCompat: src.os_compat,
      content: v.content,
      format: { encoding: v.encoding, lineEnding: v.line_ending },
      sha256: v.sha256,
      baseVersionId: v.id,
      changeNote: `Copied from "${src.name}" v${v.version_no}`,
      activity: { action: 'script.duplicate', meta: { sourceScriptId: src.id, sourceVersionId: v.id } },
    });
  });
}
