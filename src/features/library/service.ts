import 'server-only';
import { createHash } from 'node:crypto';
import { logActivity } from '@/server/activity';
import { withUser, type Tx } from '@/server/db/withUser';
import type { Script, ScriptVersion } from '@/lib/types';
import { filterScripts, type LibraryQuery } from './filters';
import { createScriptSchema, NAME_MAX, type CreateScriptInput } from './schema';
import { defaultFormat, languageFor, type TextFormat } from './scriptMeta';

/** A script row plus the number of its current version (for "v3" in the table). */
export type ScriptListItem = Script & { current_version_no: number | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const eol = { crlf: '\r\n', lf: '\n', mixed: '\n' } as const;

/** Escapes LIKE wildcards so user text is matched literally (backslash is ILIKE's default escape). */
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The user's non-archived scripts, newest first. Text search is case-insensitive substring match on
 * name, filename, description and the CURRENT version's content; every whitespace-separated term
 * must match somewhere (uses the trigram index from 0004). Category / function / scope filtering is
 * the pure filterScripts, so the sidebar counts and the table share one definition.
 */
export function searchScriptsFor(userId: string, q: LibraryQuery): Promise<ScriptListItem[]> {
  const terms = (q.text ?? '').split(/\s+/).filter(Boolean);
  return withUser(userId, async (tx) => {
    const termMatch = (t: string) => {
      const p = likePattern(t);
      return tx`(s.name ilike ${p} or s.filename ilike ${p} or coalesce(s.description, '') ilike ${p} or v.content ilike ${p})`;
    };
    const where = terms.reduce((acc, t) => tx`${acc} and ${termMatch(t)}`, tx`s.archived_at is null`);
    const rows = await tx<ScriptListItem[]>`
      select s.*, v.version_no as current_version_no
      from public.scripts s
      left join public.script_versions v on v.id = s.current_version_id
      where ${where}
      order by s.updated_at desc, s.created_at desc, s.id`;
    return filterScripts(rows, q);
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
  activity: { action: string; meta?: Record<string, unknown> };
};

/** Script row + version 1 + current_version_id + activity entry, inside the caller's transaction. */
async function insertScriptWithV1(tx: Tx, n: NewScript): Promise<Script> {
  const [row] = await tx<Script[]>`
    insert into public.scripts (name, filename, category, function, description, os_compat)
    values (${n.name}, ${n.filename}, ${n.category}::public.script_category, ${n.fn}::public.script_function,
            ${n.description ?? null}, ${n.osCompat as string[]}::public.os_type[])
    returning *`;
  const [version] = await tx<{ id: string }[]>`
    insert into public.script_versions
      (script_id, version_no, content, encoding, line_ending, language, sha256, author, change_note, base_version_id)
    values (${row!.id}, 1, ${n.content}, ${n.format.encoding}::public.text_encoding, ${n.format.lineEnding},
            ${languageFor(n.filename)}::public.script_language, ${n.sha256 ?? sha256Hex(n.content)}, 'user',
            ${n.changeNote ?? null}, ${n.baseVersionId ?? null})
    returning id`;
  const [script] = await tx<Script[]>`
    update public.scripts set current_version_id = ${version!.id}, updated_at = now() where id = ${row!.id} returning *`;
  await logActivity(tx, {
    action: n.activity.action,
    entityType: 'script',
    entityId: script!.id,
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
