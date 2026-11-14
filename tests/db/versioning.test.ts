import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestUser, sql } from './helpers';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { createScriptFor, createScriptFromUploadFor } from '@/features/library/service';
import {
  encodeForDownload,
  forkToSessionFor,
  getScriptEditorDataFor,
  getVersionFor,
  restoreVersionFor,
  saveScriptVersionFor,
  updateScriptMetadataFor,
} from '@/features/library/versioning';
import type { ScriptVersion } from '@/lib/types';

beforeAll(() => {
  process.env.DATABASE_URL ??= testDatabaseUrl();
});
afterAll(async () => {
  await closePool();
  await sql.end();
});

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const base = { category: 'windows' as const, fn: 'universal_hardening' as const, osCompat: ['windows' as const] };

async function newScript(userId: string, content = 'Write-Host one\r\n', filename = 'h.ps1') {
  const s = await createScriptFor(userId, { ...base, name: 'Harden', filename, content });
  return { script: s, v1: s.current_version_id! };
}

const versionsOf = (scriptId: string) =>
  sql<ScriptVersion[]>`select * from script_versions where script_id = ${scriptId} order by version_no`;

async function newSession(userId: string, status: 'active' | 'completed' = 'active') {
  const [s] = await sql`insert into sessions (owner_id, title, os) values (${userId}, 'Round', 'windows') returning id`;
  if (status === 'completed') await sql`update sessions set status = 'completed', completed_at = now() where id = ${s!.id}`;
  return s!.id as string;
}

describe('saveScriptVersionFor', () => {
  it('identical content returns unchanged and creates no version', async () => {
    const u = await createTestUser();
    const { script, v1 } = await newScript(u.id);
    const [before] = await versionsOf(script.id);
    const r = await saveScriptVersionFor(u.id, { scriptId: script.id, baseVersionId: v1, content: 'Write-Host one\r\n', author: 'user' });
    expect(r.status).toBe('unchanged');
    if (r.status !== 'unchanged') return;
    expect(r.version.id).toBe(v1);
    expect(r.version.sha256).toBe(before!.sha256);
    expect(r.version.sha256).toBe(sha('Write-Host one\r\n'));
    expect(await versionsOf(script.id)).toHaveLength(1);
    const acts = await sql`select action from activity_log where entity_id = ${script.id}`;
    expect(acts.map((a) => a.action)).toEqual(['script.create']);
  });

  it('LF edits of a CRLF script are stored as CRLF, so "same text, other newlines" is unchanged', async () => {
    const u = await createTestUser();
    const { script, v1 } = await newScript(u.id);
    const r = await saveScriptVersionFor(u.id, { scriptId: script.id, baseVersionId: v1, content: 'Write-Host one\n', author: 'user' });
    expect(r.status).toBe('unchanged');
  });

  it('creates the next version from the base, inheriting encoding / line ending / language', async () => {
    const u = await createTestUser();
    const s = await createScriptFor(u.id, {
      ...base,
      name: 'U16',
      filename: 'u.ps1',
      content: 'a\r\n',
      format: { encoding: 'utf-16le', lineEnding: 'crlf' },
    });
    const v1 = s.current_version_id!;
    const r = await saveScriptVersionFor(u.id, { scriptId: s.id, baseVersionId: v1, content: 'a\nb\n', changeNote: 'add b', author: 'user' });
    expect(r.status).toBe('created');
    if (r.status !== 'created') return;
    expect(r.version).toMatchObject({
      version_no: 2,
      base_version_id: v1,
      content: 'a\r\nb\r\n',
      encoding: 'utf-16le',
      line_ending: 'crlf',
      language: 'powershell',
      author: 'user',
      change_note: 'add b',
      sha256: sha('a\r\nb\r\n'),
    });
    const [row] = await sql`select current_version_id from scripts where id = ${s.id}`;
    expect(row!.current_version_id).toBe(r.version.id);
    const acts = await sql`select action, meta from activity_log where entity_id = ${s.id} order by created_at`;
    expect(acts.map((a) => a.action)).toEqual(['script.create', 'script.version.create']);
    expect(acts[1]!.meta).toMatchObject({ versionId: r.version.id, versionNo: 2, baseVersionId: v1 });
    // v1 is untouched.
    const [first] = await versionsOf(s.id);
    expect(first).toMatchObject({ id: v1, content: 'a\r\n', version_no: 1 });
  });

  it('rejects save from stale base version', async () => {
    const u = await createTestUser();
    const { script, v1 } = await newScript(u.id);
    const v2 = await saveScriptVersionFor(u.id, { scriptId: script.id, baseVersionId: v1, content: 'two\r\n', author: 'user' });
    expect(v2.status).toBe('created');
    const r = await saveScriptVersionFor(u.id, { scriptId: script.id, baseVersionId: v1, content: 'stale edit\r\n', author: 'user' });
    expect(r.status).toBe('conflict');
    if (r.status !== 'conflict') return;
    expect(r.latest.version_no).toBe(2);
    expect(r.latest.content).toBe('two\r\n');
    expect(await versionsOf(script.id)).toHaveLength(2);
    // Saving on top of the latest (the conflict UI's "Save as new version based on v2") works.
    const ok = await saveScriptVersionFor(u.id, { scriptId: script.id, baseVersionId: r.latest.id, content: 'stale edit\r\n', author: 'user' });
    expect(ok.status).toBe('created');
    if (ok.status === 'created') expect(ok.version).toMatchObject({ version_no: 3, base_version_id: r.latest.id });
  });

  it('concurrent saves from the same base: exactly one wins, the other gets a conflict', async () => {
    const u = await createTestUser();
    const { script, v1 } = await newScript(u.id);
    const results = await Promise.all(
      ['x\r\n', 'y\r\n', 'z\r\n'].map((content) => saveScriptVersionFor(u.id, { scriptId: script.id, baseVersionId: v1, content, author: 'user' })),
    );
    expect(results.map((r) => r.status).sort()).toEqual(['conflict', 'conflict', 'created']);
    expect(await versionsOf(script.id)).toHaveLength(2);
  });

  it('a mixed-line-ending base keeps the text as given and records the ending it actually has', async () => {
    const u = await createTestUser();
    const s = await createScriptFor(u.id, { ...base, name: 'M', filename: 'm.ps1', content: 'a\r\nb\n', format: { encoding: 'utf-8', lineEnding: 'mixed' } });
    const r = await saveScriptVersionFor(u.id, { scriptId: s.id, baseVersionId: s.current_version_id, content: 'a\r\nb\r\nc\r\n', author: 'user' });
    expect(r.status).toBe('created');
    if (r.status === 'created') expect(r.version).toMatchObject({ content: 'a\r\nb\r\nc\r\n', line_ending: 'crlf' });
  });

  it('Claude never writes to a universal script', async () => {
    const u = await createTestUser();
    const { script, v1 } = await newScript(u.id);
    await expect(saveScriptVersionFor(u.id, { scriptId: script.id, baseVersionId: v1, content: 'x', author: 'claude' })).rejects.toThrow(/universal/i);
    expect(await versionsOf(script.id)).toHaveLength(1);
  });

  it("cannot save to another user's script, or an unknown id", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const { script, v1 } = await newScript(a.id);
    await expect(saveScriptVersionFor(b.id, { scriptId: script.id, baseVersionId: v1, content: 'x', author: 'user' })).rejects.toThrow(/not found/i);
    await expect(saveScriptVersionFor(a.id, { scriptId: 'nope', baseVersionId: v1, content: 'x', author: 'user' })).rejects.toThrow(/not found/i);
    expect(await versionsOf(script.id)).toHaveLength(1);
  });

  it('rejects content over 2 MB', async () => {
    const u = await createTestUser();
    const { script, v1 } = await newScript(u.id, 'x\n', 'x.sh');
    await expect(
      saveScriptVersionFor(u.id, { scriptId: script.id, baseVersionId: v1, content: 'x'.repeat(2 * 1024 * 1024 + 1), author: 'user' }),
    ).rejects.toThrow(/2 MB/);
  });
});

describe('restoreVersionFor', () => {
  it('creates a new version equal to the chosen one and never mutates history', async () => {
    const u = await createTestUser();
    const { script, v1 } = await newScript(u.id);
    const v2 = await saveScriptVersionFor(u.id, { scriptId: script.id, baseVersionId: v1, content: 'two\r\n', author: 'user' });
    if (v2.status !== 'created') throw new Error('setup');
    const before = await versionsOf(script.id);
    const r = await restoreVersionFor(u.id, { scriptId: script.id, versionId: v1, baseVersionId: v2.version.id });
    expect(r.status).toBe('created');
    if (r.status !== 'created') return;
    expect(r.version).toMatchObject({ version_no: 3, content: before[0]!.content, sha256: before[0]!.sha256, base_version_id: v2.version.id, change_note: 'Restored from v1' });
    const after = await versionsOf(script.id);
    expect(after.slice(0, 2)).toEqual(before);
    // Stale base is a conflict, restoring the current content is unchanged.
    expect((await restoreVersionFor(u.id, { scriptId: script.id, versionId: v1, baseVersionId: v1 })).status).toBe('conflict');
    expect((await restoreVersionFor(u.id, { scriptId: script.id, versionId: v1, baseVersionId: r.version.id })).status).toBe('unchanged');
  });
});

describe('download round-trip through the upload path', () => {
  it.each(['utf16le-crlf.ps1', 'utf8-bom.ps1', 'lf.sh'])('round-trips %s byte-for-byte', async (name) => {
    const u = await createTestUser();
    const bytes = new Uint8Array(readFileSync(path.join(FIXTURES, name)));
    const s = await createScriptFromUploadFor(
      u.id,
      { ...base, name, filename: name, ...(name.endsWith('.sh') ? { category: 'linux' as const, osCompat: ['linux' as const] } : {}) },
      bytes,
      { storagePath: `${u.id}/x/${name}` },
    );
    const found = await getVersionFor(u.id, s.current_version_id!);
    expect(found).not.toBeNull();
    expect(Buffer.from(encodeForDownload(found!.version)).equals(Buffer.from(bytes))).toBe(true);
  });

  it('round-trips UTF-16LE + CRLF byte-for-byte after an edit too (encoding and line ending inherited)', async () => {
    const u = await createTestUser();
    const bytes = new Uint8Array(readFileSync(path.join(FIXTURES, 'utf16le-crlf.ps1')));
    const s = await createScriptFromUploadFor(u.id, { ...base, name: 'u', filename: 'u.ps1' }, bytes, { storagePath: `${u.id}/x/u.ps1` });
    const r = await saveScriptVersionFor(u.id, { scriptId: s.id, baseVersionId: s.current_version_id, content: "Write-Host 'hello'\nGet-Date\nexit 0\n", author: 'user' });
    if (r.status !== 'created') throw new Error('expected created');
    const expected = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Write-Host 'hello'\r\nGet-Date\r\nexit 0\r\n", 'utf16le')]);
    expect(Buffer.from(encodeForDownload(r.version)).equals(expected)).toBe(true);
  });
});

describe('forkToSessionFor', () => {
  it('forkToSession leaves universal current_version_id unchanged', async () => {
    const u = await createTestUser();
    const src = await createScriptFor(u.id, { ...base, name: 'Baseline', filename: 'b.ps1', description: 'd', content: 'x\r\n', format: { encoding: 'utf-16le', lineEnding: 'crlf' } });
    const sessionId = await newSession(u.id);
    const [srcBefore] = await sql`select * from scripts where id = ${src.id}`;
    const [srcV] = await versionsOf(src.id);

    const fork = await forkToSessionFor(u.id, { versionId: src.current_version_id!, sessionId });
    expect(fork).toMatchObject({
      name: 'Baseline',
      filename: 'b.ps1',
      description: 'd',
      category: 'windows',
      function: 'session_generated',
      session_id: sessionId,
      forked_from_version_id: srcV!.id,
    });
    const fv = await versionsOf(fork.id);
    expect(fv).toHaveLength(1);
    expect(fv[0]).toMatchObject({
      version_no: 1,
      content: srcV!.content,
      encoding: 'utf-16le',
      line_ending: 'crlf',
      language: srcV!.language,
      sha256: srcV!.sha256,
      author: 'user',
      change_note: 'Forked from Baseline v1',
    });
    expect(fork.current_version_id).toBe(fv[0]!.id);

    const [srcAfter] = await sql`select * from scripts where id = ${src.id}`;
    expect(srcAfter).toEqual(srcBefore);
    expect(srcAfter!.current_version_id).toBe(srcV!.id);
    expect(await versionsOf(src.id)).toHaveLength(1);
    const acts = await sql`select action, session_id from activity_log where entity_id = ${fork.id}`;
    expect(acts).toEqual([{ action: 'script.fork', session_id: sessionId }]);
  });

  it('refuses completed sessions and sessions or versions of another user', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const { script } = await newScript(a.id);
    const done = await newSession(a.id, 'completed');
    const theirs = await newSession(b.id);
    await expect(forkToSessionFor(a.id, { versionId: script.current_version_id!, sessionId: done })).rejects.toThrow(/completed/i);
    await expect(forkToSessionFor(a.id, { versionId: script.current_version_id!, sessionId: theirs })).rejects.toThrow(/session not found/i);
    await expect(forkToSessionFor(b.id, { versionId: script.current_version_id!, sessionId: theirs })).rejects.toThrow(/version not found/i);
    const [n] = await sql`select count(*)::int as n from scripts where owner_id = ${a.id}`;
    expect(n!.n).toBe(1);
  });
});

describe('reads', () => {
  it('editor data lists versions newest first without content; versions of others are invisible', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const { script, v1 } = await newScript(a.id);
    await saveScriptVersionFor(a.id, { scriptId: script.id, baseVersionId: v1, content: 'two\r\n', author: 'user' });
    const data = await getScriptEditorDataFor(a.id, script.id);
    expect(data!.current).toMatchObject({ version_no: 2, content: 'two\r\n' });
    expect(data!.versions.map((v) => v.version_no)).toEqual([2, 1]);
    expect(data!.versions[0]).not.toHaveProperty('content');
    expect(await getScriptEditorDataFor(b.id, script.id)).toBeNull();
    expect(await getVersionFor(b.id, v1)).toBeNull();
    expect(await getVersionFor(a.id, 'nope')).toBeNull();
  });
});

describe('updateScriptMetadataFor', () => {
  it('validates, updates name/description/os/category, logs, and never touches versions', async () => {
    const u = await createTestUser();
    const { script } = await newScript(u.id);
    const before = await versionsOf(script.id);
    const s = await updateScriptMetadataFor(u.id, script.id, { name: '  Renamed ', description: 'new', osCompat: ['windows', 'windows_server'], category: 'windows_server' });
    expect(s).toMatchObject({ name: 'Renamed', description: 'new', os_compat: ['windows', 'windows_server'], category: 'windows_server', filename: 'h.ps1' });
    expect(await versionsOf(script.id)).toEqual(before);
    const acts = await sql`select action from activity_log where entity_id = ${script.id} order by created_at`;
    expect(acts.map((a) => a.action)).toEqual(['script.create', 'script.update']);
    await expect(updateScriptMetadataFor(u.id, script.id, { name: '', osCompat: ['windows'], category: 'windows' })).rejects.toThrow();
    await expect(updateScriptMetadataFor(u.id, script.id, { name: 'x', osCompat: [], category: 'windows' })).rejects.toThrow();
  });
});
