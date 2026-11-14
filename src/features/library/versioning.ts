import 'server-only';
import { logActivity } from '@/server/activity';
import { requireUser } from '@/server/auth';
import { withUser, type Tx } from '@/server/db/withUser';
import { lineEndingOf } from '@/server/files/encoding';
import { cp1252Encodable, encodeCp1252 } from '@/lib/cp1252';
import { MAX_TEXT_BYTES } from '@/server/files/limits';
import type { LineEnding, ScriptAuthor } from '@/server/db/types';
import type { Script, ScriptVersion, TextEncoding } from '@/lib/types';
import { updateScriptSchema, type UpdateScriptInput } from './schema';
import { defaultFormat, languageFor } from './scriptMeta';
import { insertScriptWithV1, sha256Hex } from './service';
import type { SaveResult, ScriptEditorData, VersionSummary } from './versionTypes';

export type { SaveResult, ScriptEditorData, VersionSummary } from './versionTypes';

/*
 * Script versions are immutable (the DB refuses UPDATE/DELETE on script_versions). Every edit,
 * restore or fork INSERTS a version; the script row only moves its current_version_id pointer.
 *
 * Content invariant (shared with Task 8's createScript): a version's `content` already carries
 * the newlines of its `line_ending`, and `encoding` says how to turn that string back into bytes.
 * So a download only re-applies the byte encoding (encodeForDownload) and never touches newlines.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

/** Raised for edits the rules forbid (e.g. Claude writing a universal script, a completed session). */
export class ForbiddenEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenEditError';
  }
}

export class ContentTooLargeError extends Error {
  constructor() {
    super('Scripts can be at most 2 MB.');
    this.name = 'ContentTooLargeError';
  }
}

export type SaveInput = {
  scriptId: string;
  /** The version the edits started from. Must equal the script's current version, else 'conflict'. */
  baseVersionId: string | null;
  content: string;
  changeNote?: string;
  author: ScriptAuthor;
};

const EOL = { crlf: '\r\n', lf: '\n' } as const;

/**
 * Rewrites every newline (CRLF, LF, lone CR) to the declared ending. 'mixed' text is returned as is:
 * there is no single ending to restore, so the stored string is the source of truth.
 */
export function normalizeForLineEnding(content: string, lineEnding: LineEnding): string {
  return lineEnding === 'mixed' ? content : content.replace(/\r\n|\r|\n/g, EOL[lineEnding]);
}

const bom = { 'utf-16le': [0xff, 0xfe], 'utf-16be': [0xfe, 0xff] } as const;

/**
 * The bytes of a version as a file: its content in its recorded `encoding`, BOM included
 * (utf-8: none; utf-8-bom: EF BB BF; utf-16le: FF FE; utf-16be: FE FF; windows-1252: one byte per
 * character, no BOM). Newlines are NOT converted — the stored string already has the version's line
 * ending (CRLF for new .ps1/.bat/.cmd files).
 *
 * Fidelity: for an upload, content/encoding came from decodeText, so this reproduces the uploaded
 * bytes exactly for UTF-8 (with or without BOM), BOM-marked UTF-16 and ANSI (Windows-1252). One
 * documented exception: BOM-less UTF-16 downloads with a BOM (TextEncoding has no "UTF-16 without
 * BOM" value). A windows-1252 version only ever holds text that encoding can store (saves that add
 * other characters switch the new version to UTF-8, see saveScriptVersionFor), so encodeCp1252 never
 * throws for stored versions.
 */
export function encodeForDownload(v: Pick<ScriptVersion, 'content' | 'encoding'>): Uint8Array<ArrayBuffer> {
  if (v.encoding === 'windows-1252') return encodeCp1252(v.content);
  if (v.encoding === 'utf-8' || v.encoding === 'utf-8-bom') {
    const body = new TextEncoder().encode(v.content);
    if (v.encoding === 'utf-8') return body;
    const out = new Uint8Array(3 + body.length);
    out.set([0xef, 0xbb, 0xbf], 0);
    out.set(body, 3);
    return out;
  }
  const le = v.encoding === 'utf-16le';
  const out = new Uint8Array(2 + v.content.length * 2);
  out.set(bom[v.encoding], 0);
  const view = new DataView(out.buffer);
  for (let i = 0; i < v.content.length; i++) view.setUint16(2 + i * 2, v.content.charCodeAt(i), le);
  return out;
}

/**
 * `attachment` with an ASCII-only quoted `filename` (anything outside printable ASCII, quotes and
 * backslashes become `_`) plus the exact name as RFC 5987 `filename*`. Never contains CR/LF.
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const tooLarge = (content: string) => new TextEncoder().encode(content).length > MAX_TEXT_BYTES;

async function lockScript(tx: Tx, scriptId: string): Promise<Script> {
  const [script] = UUID_RE.test(scriptId)
    ? await tx<Script[]>`select * from public.scripts where id = ${scriptId} for update`
    : [];
  if (!script) throw new NotFoundError('Script');
  return script;
}

async function versionById(tx: Tx, id: string | null): Promise<ScriptVersion | null> {
  if (!id || !UUID_RE.test(id)) return null;
  const [v] = await tx<ScriptVersion[]>`select * from public.script_versions where id = ${id}`;
  return v ?? null;
}

type NewVersion = Pick<ScriptVersion, 'content' | 'encoding' | 'line_ending' | 'language' | 'author'> & {
  change_note: string | null;
  sha256: string;
};

/** Inserts version max+1 on top of `base`, moves current_version_id, logs. Caller holds the script lock. */
async function insertNext(tx: Tx, script: Script, base: ScriptVersion | null, v: NewVersion, action: string, meta: Record<string, unknown> = {}) {
  const [inserted] = await tx<ScriptVersion[]>`
    insert into public.script_versions
      (script_id, version_no, content, encoding, line_ending, language, sha256, author, change_note, base_version_id)
    values (${script.id},
            (select coalesce(max(version_no), 0) + 1 from public.script_versions where script_id = ${script.id}),
            ${v.content}, ${v.encoding}::public.text_encoding, ${v.line_ending}, ${v.language}::public.script_language,
            ${v.sha256}, ${v.author}, ${v.change_note}, ${base?.id ?? null})
    returning *`;
  await tx`update public.scripts set current_version_id = ${inserted!.id}, updated_at = now() where id = ${script.id}`;
  await logActivity(tx, {
    action,
    entityType: 'script',
    entityId: script.id,
    ...(script.session_id ? { sessionId: script.session_id } : {}),
    meta: { versionId: inserted!.id, versionNo: inserted!.version_no, baseVersionId: base?.id ?? null, author: v.author, encoding: v.encoding, ...meta },
  });
  return inserted!;
}

/**
 * Saves `content` as the next version of a script, in one transaction holding the script row lock
 * (`select … for update`), so concurrent saves serialize:
 *  - baseVersionId ≠ the script's current version → `conflict` with the latest version; nothing is written.
 *  - same sha256 as the current version (after newline normalization) → `unchanged`; nothing is written.
 *  - otherwise version max+1 with base_version_id = base, encoding / language inherited from the
 *    base (except a windows-1252 base whose new text does not fit: UTF-8, see below), newlines normalized to the base's line ending (a 'mixed' base keeps the text as given and
 *    records the ending it actually has), current_version_id moved, activity logged.
 * A user may version a universal script explicitly (history stays recoverable); Claude may not —
 * Claude's edits go to a session fork (forkToSession).
 */
export function saveScriptVersionFor(userId: string, input: SaveInput): Promise<SaveResult> {
  return withUser(userId, async (tx) => {
    const script = await lockScript(tx, input.scriptId);
    if (input.author === 'claude' && script.session_id === null) {
      throw new ForbiddenEditError('Claude cannot change a universal script. Fork it into a session first.');
    }
    const current = await versionById(tx, script.current_version_id);
    if ((input.baseVersionId ?? null) !== (script.current_version_id ?? null)) {
      if (current) return { status: 'conflict', latest: current };
      throw new NotFoundError('Version');
    }
    const defaults = defaultFormat(script.filename);
    const lineEnding0 = current?.line_ending ?? defaults.lineEnding;
    const content = normalizeForLineEnding(input.content, lineEnding0);
    if (tooLarge(content)) throw new ContentTooLargeError();
    const sha256 = sha256Hex(content);
    if (current && current.sha256 === sha256) return { status: 'unchanged', version: current };
    // An ANSI file that gains characters Windows-1252 cannot store (→, emoji, CJK, …) is written as
    // UTF-8 from this version on — BOM for .ps1 so Windows PowerShell 5.1 reads it as UTF-8, none for
    // .bat/.cmd (cmd.exe would run the BOM as part of the first command) — instead of losing text.
    let encoding: TextEncoding = current?.encoding ?? defaults.encoding;
    const encodingChangedFrom = encoding === 'windows-1252' && !cp1252Encodable(content) ? encoding : null;
    if (encodingChangedFrom) encoding = defaults.encoding;
    const version = await insertNext(tx, script, current, {
      content,
      sha256,
      encoding,
      line_ending: lineEnding0 === 'mixed' ? lineEndingOf(content) : lineEnding0,
      language: current?.language ?? languageFor(script.filename),
      author: input.author,
      change_note: input.changeNote?.trim() || null,
    }, 'script.version.create', encodingChangedFrom ? { encodingChangedFrom } : {});
    return { status: 'created', version };
  });
}

/**
 * "Restore": a NEW version whose content, encoding, line ending, language and sha256 equal the
 * chosen old version (based on the current one). History is never rewritten. Same conflict and
 * unchanged rules as saveScriptVersionFor.
 */
export function restoreVersionFor(
  userId: string,
  input: { scriptId: string; versionId: string; baseVersionId: string | null },
): Promise<SaveResult> {
  return withUser(userId, async (tx) => {
    const script = await lockScript(tx, input.scriptId);
    const source = await versionById(tx, input.versionId);
    if (!source || source.script_id !== script.id) throw new NotFoundError('Version');
    const current = await versionById(tx, script.current_version_id);
    if (!current) throw new NotFoundError('Version');
    if (input.baseVersionId !== current.id) return { status: 'conflict', latest: current };
    if (current.sha256 === source.sha256) return { status: 'unchanged', version: current };
    const version = await insertNext(tx, script, current, {
      content: source.content,
      sha256: source.sha256,
      encoding: source.encoding,
      line_ending: source.line_ending,
      language: source.language,
      author: 'user',
      change_note: `Restored from v${source.version_no}`,
    }, 'script.version.restore', { restoredFromVersionId: source.id });
    return { status: 'created', version };
  });
}

/**
 * Copies one version into an active session as a new session script ('session_generated',
 * forked_from_version_id = that version) at v1 with identical content/encoding/line ending/language/
 * sha256. The source script is not touched.
 */
export function forkToSessionFor(userId: string, input: { versionId: string; sessionId: string }): Promise<Script> {
  return withUser(userId, async (tx) => {
    const [session] = UUID_RE.test(input.sessionId)
      ? await tx<{ id: string; status: string }[]>`select id, status from public.sessions where id = ${input.sessionId}`
      : [];
    if (!session) throw new NotFoundError('Session');
    if (session.status !== 'active') throw new ForbiddenEditError('That session is completed and read-only.');
    const source = await versionById(tx, input.versionId);
    const [src] = source ? await tx<Script[]>`select * from public.scripts where id = ${source.script_id}` : [];
    if (!source || !src) throw new NotFoundError('Version');
    return insertScriptWithV1(tx, {
      name: src.name,
      filename: src.filename,
      category: src.category,
      fn: 'session_generated',
      description: src.description,
      osCompat: src.os_compat,
      content: source.content,
      format: { encoding: source.encoding, lineEnding: source.line_ending },
      language: source.language,
      sha256: source.sha256,
      sessionId: session.id,
      forkedFromVersionId: source.id,
      changeNote: `Forked from ${src.name} v${source.version_no}`,
      activity: { action: 'script.fork', meta: { sourceScriptId: src.id, sourceVersionId: source.id } },
    });
  });
}

/** Name / description / systems / category. Filename and function are fixed. Validated, logged. */
export async function updateScriptMetadataFor(userId: string, scriptId: string, input: UpdateScriptInput): Promise<Script> {
  const data = updateScriptSchema.parse(input);
  return withUser(userId, async (tx) => {
    await lockScript(tx, scriptId);
    const [script] = await tx<Script[]>`
      update public.scripts
         set name = ${data.name}, description = ${data.description ?? null},
             os_compat = ${data.osCompat as string[]}::public.os_type[],
             category = ${data.category}::public.script_category, updated_at = now()
       where id = ${scriptId}
       returning *`;
    await logActivity(tx, {
      action: 'script.update',
      entityType: 'script',
      entityId: script!.id,
      ...(script!.session_id ? { sessionId: script!.session_id } : {}),
      meta: { name: data.name, category: data.category, osCompat: data.osCompat },
    });
    return script!;
  });
}

/** The script, its current version (with content) and every version newest first (without content). */
export function getScriptEditorDataFor(userId: string, scriptId: string): Promise<ScriptEditorData | null> {
  if (!UUID_RE.test(scriptId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const [script] = await tx<Script[]>`select * from public.scripts where id = ${scriptId}`;
    const current = script ? await versionById(tx, script.current_version_id) : null;
    if (!script || !current) return null;
    const versions = await tx<VersionSummary[]>`
      select id, owner_id, created_at, script_id, version_no, encoding, line_ending, language, sha256, author,
             change_note, base_version_id
        from public.script_versions where script_id = ${scriptId} order by version_no desc`;
    const [session] = script.session_id
      ? await tx<{ status: string }[]>`select status from public.sessions where id = ${script.session_id}`
      : [];
    return { script, current, versions: [...versions], readOnly: session?.status === 'completed' };
  });
}

/** One version (content included) with its script, or null (missing, malformed id, or not yours). */
export function getVersionFor(userId: string, versionId: string): Promise<{ script: Script; version: ScriptVersion } | null> {
  if (!UUID_RE.test(versionId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const version = await versionById(tx, versionId);
    const [script] = version ? await tx<Script[]>`select * from public.scripts where id = ${version.script_id}` : [];
    return version && script ? { script, version } : null;
  });
}

// --- Entry points for other server code (Task 14 etc.): the signed-in user, author passed through. ---

/** Saves a new version for the signed-in user. Server-side only; the browser goes through saveScriptVersionAction (author 'user'). */
export async function saveScriptVersion(input: SaveInput): Promise<SaveResult> {
  const user = await requireUser();
  return saveScriptVersionFor(user.id, input);
}

/** Forks a version into one of the signed-in user's active sessions. */
export async function forkToSession(input: { versionId: string; sessionId: string }): Promise<Script> {
  const user = await requireUser();
  return forkToSessionFor(user.id, input);
}
