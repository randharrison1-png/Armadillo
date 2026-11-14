import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createTestUser, sql } from './helpers';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { createScriptFor, duplicateScriptFor, getScriptWithContentFor, libraryCountsFor, searchQuery, searchScriptsFor } from '@/features/library/service';

beforeAll(() => {
  process.env.DATABASE_URL ??= testDatabaseUrl();
});
afterAll(async () => {
  await closePool();
  await sql.end();
});

const base = {
  category: 'windows' as const,
  fn: 'universal_hardening' as const,
  osCompat: ['windows' as const],
};

describe('createScriptFor', () => {
  it('inserts script + version 1 and sets current_version_id, with activity, in one go', async () => {
    const u = await createTestUser();
    const s = await createScriptFor(u.id, { ...base, name: 'Firewall', filename: 'fw.ps1', content: 'Set-NetFirewallProfile -Enabled True\n' });
    expect(s).toMatchObject({ name: 'Firewall', filename: 'fw.ps1', session_id: null, owner_id: u.id });
    const [v] = await sql`select * from script_versions where script_id = ${s.id}`;
    expect(s.current_version_id).toBe(v.id);
    expect(v).toMatchObject({ version_no: 1, author: 'user', language: 'powershell', encoding: 'utf-8-bom', line_ending: 'crlf' });
    expect(v.content).toBe('Set-NetFirewallProfile -Enabled True\r\n'); // stored text matches its declared line ending
    expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    const acts = await sql`select action, entity_id from activity_log where entity_id = ${s.id}`;
    expect(acts).toEqual([{ action: 'script.create', entity_id: s.id }]);
  });

  it('uses the upload format when given, and defaults .sh to utf-8 + lf', async () => {
    const u = await createTestUser();
    const a = await createScriptFor(u.id, { ...base, name: 'u', filename: 'u.ps1', content: 'x\r\n', format: { encoding: 'utf-16le', lineEnding: 'crlf' } });
    const [va] = await sql`select encoding, line_ending, content from script_versions where script_id = ${a.id}`;
    expect(va).toMatchObject({ encoding: 'utf-16le', line_ending: 'crlf', content: 'x\r\n' });
    const b = await createScriptFor(u.id, { ...base, category: 'linux', osCompat: ['linux'], name: 'l', filename: 'l.sh', content: 'a\r\nb' });
    const [vb] = await sql`select encoding, line_ending, language, content from script_versions where script_id = ${b.id}`;
    expect(vb).toMatchObject({ encoding: 'utf-8', line_ending: 'lf', language: 'bash', content: 'a\nb' });
  });

  it('rejects invalid input (session_generated, bad extension, no OS)', async () => {
    const u = await createTestUser();
    await expect(createScriptFor(u.id, { ...base, fn: 'session_generated' as never, name: 'x', filename: 'x.ps1', content: '' })).rejects.toThrow();
    await expect(createScriptFor(u.id, { ...base, name: 'x', filename: 'x.exe', content: '' })).rejects.toThrow();
    await expect(createScriptFor(u.id, { ...base, osCompat: [], name: 'x', filename: 'x.ps1', content: '' })).rejects.toThrow();
  });

  it("a user cannot read another user's scripts", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const s = await createScriptFor(a.id, { ...base, name: 'Mine', filename: 'm.ps1', content: 'secret-token' });
    expect(await searchScriptsFor(b.id, { text: 'secret-token' })).toEqual([]);
    expect(await getScriptWithContentFor(b.id, s.id)).toBeNull();
    expect(await asUser(b.id, (tx) => tx`select 1 from scripts where id = ${s.id}`)).toHaveLength(0);
  });
});

describe('searchScriptsFor', () => {
  it('matches name, filename, description and the current version content (code tokens included)', async () => {
    const u = await createTestUser();
    await createScriptFor(u.id, { ...base, name: 'Alpha', filename: 'alpha.ps1', description: 'locks down RDP', content: 'Set-NetFirewallProfile -Profile Domain\n' });
    await createScriptFor(u.id, { ...base, name: 'Beta', filename: 'beta-audit.bat', content: 'echo hi\n' });
    const names = async (text: string) => (await searchScriptsFor(u.id, { text })).map((s) => s.name);
    expect(await names('Set-NetFirewallProfile')).toEqual(['Alpha']); // content-only token
    expect(await names('set-netfirewall')).toEqual(['Alpha']); // case-insensitive partial
    expect(await names('alpha')).toEqual(['Alpha']); // name
    expect(await names('beta-audit')).toEqual(['Beta']); // filename
    expect(await names('rdp')).toEqual(['Alpha']); // description
    expect(await names('Set-NetFirewallProfile Domain')).toEqual(['Alpha']); // all terms must match
    expect(await names('Set-NetFirewallProfile nothere')).toEqual([]);
    expect(await names('')).toHaveLength(2); // blank search lists everything
  });

  it('treats LIKE wildcards literally', async () => {
    const u = await createTestUser();
    await createScriptFor(u.id, { ...base, name: 'Plain', filename: 'p.ps1', content: 'abc' });
    expect(await searchScriptsFor(u.id, { text: '%' })).toEqual([]);
    expect(await searchScriptsFor(u.id, { text: '_' })).toEqual([]);
  });

  it('searches only the CURRENT version content', async () => {
    const u = await createTestUser();
    const s = await createScriptFor(u.id, { ...base, name: 'Versioned', filename: 'v.ps1', content: 'old-token' });
    const [v1] = await sql`select id from script_versions where script_id = ${s.id}`;
    const [v2] = await sql`
      insert into script_versions (owner_id, script_id, version_no, content, encoding, line_ending, language, sha256, author, base_version_id)
      values (${u.id}, ${s.id}, 2, 'new-token', 'utf-8-bom', 'crlf', 'powershell', ${'a'.repeat(64)}, 'user', ${v1.id}) returning id`;
    await sql`update scripts set current_version_id = ${v2.id} where id = ${s.id}`;
    expect(await searchScriptsFor(u.id, { text: 'old-token' })).toEqual([]);
    expect((await searchScriptsFor(u.id, { text: 'new-token' })).map((x) => x.name)).toEqual(['Versioned']);
    expect((await searchScriptsFor(u.id, { text: 'new-token' }))[0]!.current_version_no).toBe(2);
  });

  it('excludes archived scripts, and hides session scripts from the default universal view', async () => {
    const u = await createTestUser();
    const keep = await createScriptFor(u.id, { ...base, name: 'Keep', filename: 'k.ps1', content: 'k' });
    const gone = await createScriptFor(u.id, { ...base, name: 'Gone', filename: 'g.ps1', content: 'g' });
    await sql`update scripts set archived_at = now() where id = ${gone.id}`;
    const [sess] = await sql`insert into sessions (owner_id, title, os) values (${u.id}, 'S', 'windows') returning id`;
    const [ss] = await sql`
      insert into scripts (owner_id, name, filename, category, function, os_compat, session_id)
      values (${u.id}, 'Sess', 's.ps1', 'windows', 'session_generated', '{windows}', ${sess.id}) returning id`;
    expect((await searchScriptsFor(u.id, {})).map((s) => s.id)).toEqual([keep.id]);
    expect((await searchScriptsFor(u.id, { scope: 'all' })).map((s) => s.id).sort()).toEqual([keep.id, ss.id].sort());
    expect((await searchScriptsFor(u.id, { scope: 'session' })).map((s) => s.id)).toEqual([ss.id]);
  });

  it('filters by category and function, newest first', async () => {
    const u = await createTestUser();
    await createScriptFor(u.id, { ...base, name: 'W', filename: 'w.ps1', content: 'w' });
    await createScriptFor(u.id, { ...base, category: 'linux', osCompat: ['linux'], name: 'L', filename: 'l.sh', content: 'l' });
    await createScriptFor(u.id, { ...base, category: 'leads_audit', fn: 'leads_audit', name: 'A', filename: 'a.ps1', content: 'a' });
    expect((await searchScriptsFor(u.id, {})).map((s) => s.name)).toEqual(['A', 'L', 'W']);
    expect((await searchScriptsFor(u.id, { category: 'linux' })).map((s) => s.name)).toEqual(['L']);
    expect((await searchScriptsFor(u.id, { fn: 'leads_audit' })).map((s) => s.name)).toEqual(['A']);
  });
});

describe('duplicateScriptFor', () => {
  it('creates a new universal script at v1 from the current version and leaves the source untouched', async () => {
    const u = await createTestUser();
    const src = await createScriptFor(u.id, { ...base, name: 'Source', filename: 's.ps1', description: 'd', content: 'echo 1\n', format: { encoding: 'utf-16le', lineEnding: 'crlf' } });
    const [srcV] = await sql`select * from script_versions where script_id = ${src.id}`;
    const before = await sql`select * from scripts where id = ${src.id}`;

    const copy = await duplicateScriptFor(u.id, src.id);
    expect(copy.id).not.toBe(src.id);
    expect(copy).toMatchObject({ name: 'Source (copy)', filename: 's.ps1', session_id: null, description: 'd', category: 'windows', function: 'universal_hardening' });
    const cv = await sql`select * from script_versions where script_id = ${copy.id}`;
    expect(cv).toHaveLength(1);
    expect(cv[0]).toMatchObject({ version_no: 1, content: srcV.content, encoding: 'utf-16le', line_ending: 'crlf', sha256: srcV.sha256, base_version_id: srcV.id });
    expect(copy.current_version_id).toBe(cv[0]!.id);

    expect(await sql`select * from scripts where id = ${src.id}`).toEqual(before);
    expect(await sql`select id from script_versions where script_id = ${src.id}`).toHaveLength(1);
    const acts = await sql`select action from activity_log where entity_id = ${copy.id}`;
    expect(acts.map((a) => a.action)).toEqual(['script.duplicate']);
  });

  it('copies a session-generated script as a universal one, and fails for unknown / foreign ids', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const s = await createScriptFor(a.id, { ...base, name: 'Mine', filename: 'm.ps1', content: 'x' });
    await expect(duplicateScriptFor(b.id, s.id)).rejects.toThrow(/not found/i);
    await expect(duplicateScriptFor(a.id, '00000000-0000-4000-8000-000000000000')).rejects.toThrow(/not found/i);
    await expect(duplicateScriptFor(a.id, 'nope')).rejects.toThrow(/not found/i);
  });

  it('caps the copy name at 200 characters', async () => {
    const u = await createTestUser();
    const s = await createScriptFor(u.id, { ...base, name: 'n'.repeat(200), filename: 'n.ps1', content: 'x' });
    const c = await duplicateScriptFor(u.id, s.id);
    expect(c.name).toHaveLength(200);
    expect(c.name.endsWith('(copy)')).toBe(true);
  });
});

describe('search index', () => {
  it('has a trigram index on script_versions.content', async () => {
    const [r] = await sql`select indexdef from pg_indexes where tablename = 'script_versions' and indexdef ilike '%gin_trgm_ops%'`;
    expect(r.indexdef).toContain('content');
  });
});

describe('libraryCountsFor', () => {
  it('counts universal, non-archived scripts per category with one grouped query', async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    await createScriptFor(u.id, { ...base, name: 'w1', filename: 'a.ps1', content: 'x' });
    await createScriptFor(u.id, { ...base, name: 'w2', filename: 'b.ps1', content: 'x' });
    const gone = await createScriptFor(u.id, { ...base, name: 'w3', filename: 'c.ps1', content: 'x' });
    await createScriptFor(u.id, { ...base, category: 'linux', osCompat: ['linux'], name: 'l1', filename: 'l.sh', content: 'x' });
    await createScriptFor(other.id, { ...base, name: 'theirs', filename: 't.ps1', content: 'x' });
    await sql`update scripts set archived_at = now() where id = ${gone.id}`;
    const [sess] = await sql`insert into sessions (owner_id, title, os) values (${u.id}, 'S', 'windows') returning id`;
    await sql`insert into scripts (owner_id, name, filename, category, function, os_compat, session_id)
      values (${u.id}, 'Sess', 's.ps1', 'windows', 'session_generated', '{windows}', ${sess.id})`;
    expect(await libraryCountsFor(u.id)).toEqual({ windows: 2, linux: 1 });
    expect(await libraryCountsFor(other.id)).toEqual({ windows: 1 });
  });
});

describe('search limit and index eligibility', () => {
  it('limits rows, newest first', async () => {
    const u = await createTestUser();
    for (const n of ['a', 'b', 'c']) await createScriptFor(u.id, { ...base, name: n, filename: `${n}.ps1`, content: n });
    expect((await searchScriptsFor(u.id, {}, 2)).map((s) => s.name)).toEqual(['c', 'b']);
  });

  it('content and metadata predicates can use the trigram indexes', async () => {
    const u = await createTestUser();
    for (let i = 0; i < 30; i++) await createScriptFor(u.id, { ...base, name: `bulk ${i}`, filename: `b${i}.ps1`, content: `Write-Host ${i}` });
    // Admin transaction (no RLS owner filter) so the plan reflects index eligibility of the ILIKE predicates.
    const plan = await sql.begin(async (tx) => {
      await tx`analyze public.scripts`;
      await tx`analyze public.script_versions`;
      await tx`set local enable_seqscan = off`;
      await tx`set local enable_indexscan = off`; // leave only bitmap scans, i.e. the trigram GIN indexes, on tiny tables
      const rows = await tx`explain ${searchQuery(tx, { text: 'Set-NetFirewallProfile' })}`;
      return rows.map((r) => r['QUERY PLAN'] as string).join('\n');
    });
    expect(plan).toContain('script_versions_content_trgm_idx');
    expect(plan).toContain('scripts_name_trgm_idx');
    expect(plan).toContain('scripts_filename_trgm_idx');
    expect(plan).toContain('scripts_description_trgm_idx');
  });
});
