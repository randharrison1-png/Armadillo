import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAnon, asUser, createTestUser, sql } from './helpers';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { deletePasteFor, getPaste, listMyPastes, searchPublicPastes, updatePasteFor } from '@/features/pastebin/service';

beforeAll(() => {
  process.env.DATABASE_URL ??= testDatabaseUrl();
});
afterAll(async () => {
  await closePool();
  await sql.end();
});

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const slug = () => Array.from(randomBytes(10), (b) => ALPHABET[b % 64]).join('');

async function seed(
  ownerId: string,
  o: Partial<{ slug: string; title: string; content: string; language: string; visibility: string; expires_at: Date | null; deleted_at: Date | null; created_at: Date }> = {},
) {
  const s = o.slug ?? slug();
  await sql`
    insert into paste.pastes (slug, owner_id, title, content, language, visibility, expires_at, deleted_at, created_at)
    values (${s}, ${ownerId}, ${o.title ?? 'T'}, ${o.content ?? 'hello'}, ${o.language ?? 'text'}, ${o.visibility ?? 'public'},
            ${o.expires_at ?? null}, ${o.deleted_at ?? null}, ${o.created_at ?? new Date()})`;
  return s;
}
const past = (ms: number) => new Date(Date.now() - ms);
const future = (ms: number) => new Date(Date.now() + ms);

describe('paste schema boundary', () => {
  it('paste schema has no foreign keys into public schema (and public has none into paste)', async () => {
    const fks = await sql<{ from_schema: string; from_table: string; to_schema: string; to_table: string }[]>`
      select cn.nspname as from_schema, c.relname as from_table, tn.nspname as to_schema, t.relname as to_table
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid join pg_namespace cn on cn.oid = c.relnamespace
      join pg_class t on t.oid = k.confrelid join pg_namespace tn on tn.oid = t.relnamespace
      where k.contype = 'f' and (cn.nspname = 'paste' or tn.nspname = 'paste')`;
    // The only allowed reference is owner_id -> auth.users.
    for (const fk of fks) {
      expect(fk.from_schema).toBe('paste');
      expect(fk.to_schema).toBe('auth');
      expect(fk.to_table).toBe('users');
    }
    expect(fks.some((f) => f.to_schema === 'public' || f.from_schema === 'public')).toBe(false);
  });

  it('RLS is enabled on both tables and grants are minimal', async () => {
    const rls = await sql`select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'paste' and relkind = 'r' order by relname`;
    expect(rls.map((r) => [r.relname, r.relrowsecurity])).toEqual([['pastes', true], ['reports', true]]);

    const has = async (role: string, table: string, priv: string) =>
      (await sql`select has_table_privilege(${role}, ${table}, ${priv}) as ok`)[0].ok as boolean;
    expect((await sql`select has_any_column_privilege('anon', 'paste.pastes', 'select') as ok`)[0].ok).toBe(true); // column-level grant
    for (const p of ['insert', 'update', 'delete']) expect(await has('anon', 'paste.pastes', p)).toBe(false);
    for (const p of ['select', 'insert', 'delete']) expect(await has('authenticated', 'paste.pastes', p)).toBe(true);
    expect((await sql`select has_column_privilege('authenticated', 'paste.pastes', 'slug', 'update') as ok`)[0].ok).toBe(false);
    expect((await sql`select has_column_privilege('authenticated', 'paste.pastes', 'title', 'update') as ok`)[0].ok).toBe(true);
    for (const r of ['anon', 'authenticated']) {
      expect(await has(r, 'paste.reports', 'insert')).toBe(true);
      for (const p of ['select', 'update', 'delete']) expect(await has(r, 'paste.reports', p)).toBe(false);
    }
    for (const t of ['paste.pastes', 'paste.reports']) for (const p of ['select', 'insert', 'update', 'delete']) expect(await has('service_role', t, p)).toBe(false);
    expect((await sql`select has_schema_privilege('anon', 'paste', 'usage') as ok`)[0].ok).toBe(true);
    // anon never sees who owns a paste.
    expect((await sql`select has_column_privilege('anon', 'paste.pastes', 'owner_id', 'select') as ok`)[0].ok).toBe(false);
  });

  it('enforces slug format, size, language and visibility constraints', async () => {
    const u = await createTestUser();
    await expect(seed(u.id, { slug: 'short' })).rejects.toThrow();
    await expect(seed(u.id, { slug: 'has space!!' })).rejects.toThrow();
    await expect(seed(u.id, { language: 'cobol' })).rejects.toThrow();
    await expect(seed(u.id, { visibility: 'secret' })).rejects.toThrow();
    await expect(seed(u.id, { title: 'x'.repeat(201) })).rejects.toThrow();
    await expect(seed(u.id, { content: 'a'.repeat(512 * 1024 + 1) })).rejects.toThrow();
    await seed(u.id, { content: 'a'.repeat(512 * 1024) }); // exactly 512 KB is fine
    await seed(u.id, { content: 'é'.repeat(262144) }); // 512 KB in bytes (2 per char)
    await expect(seed(u.id, { content: 'é'.repeat(262145) })).rejects.toThrow();
  });
});

describe('RLS', () => {
  it('anon cannot read expired or deleted pastes; reads live public and unlisted', async () => {
    const u = await createTestUser();
    const live = await seed(u.id);
    const unlisted = await seed(u.id, { visibility: 'unlisted' });
    const notYet = await seed(u.id, { expires_at: future(3600_000) });
    const expired = await seed(u.id, { expires_at: past(1000) });
    const deleted = await seed(u.id, { deleted_at: past(1000) });
    const seen = await asAnon(async (tx) => (await tx`select slug from paste.pastes where slug in ${tx([live, unlisted, notYet, expired, deleted])}`).map((r) => r.slug));
    expect(seen.sort()).toEqual([live, unlisted, notYet].sort());
  });

  it('non-owner cannot update or delete; anon cannot write at all', async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const s = await seed(owner.id, { title: 'mine' });
    await asUser(other.id, async (tx) => {
      expect((await tx`update paste.pastes set title = 'hijack' where slug = ${s} returning slug`).length).toBe(0);
      expect((await tx`delete from paste.pastes where slug = ${s} returning slug`).length).toBe(0);
    });
    await asAnon(async (tx) => {
      await expect(tx.savepoint((sp) => sp`update paste.pastes set title = 'x' where slug = ${s}`)).rejects.toThrow(/permission denied/);
      await expect(tx.savepoint((sp) => sp`delete from paste.pastes where slug = ${s}`)).rejects.toThrow(/permission denied/);
    });
    expect((await sql`select title from paste.pastes where slug = ${s}`)[0].title).toBe('mine');
  });

  it('owner can update own paste but not slug/owner, cannot un-delete or edit a deleted paste, cannot insert for someone else', async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const s = await seed(owner.id);
    await asUser(owner.id, async (tx) => {
      expect((await tx`update paste.pastes set title = 'new' where slug = ${s} returning title`)[0].title).toBe('new');
      await expect(tx.savepoint((sp) => sp`update paste.pastes set slug = 'ZZZZZZZZZZ' where slug = ${s}`)).rejects.toThrow(/permission denied/);
      await expect(tx.savepoint((sp) => sp`update paste.pastes set owner_id = ${other.id} where slug = ${s}`)).rejects.toThrow(/permission denied/);
      await expect(
        tx.savepoint((sp) => sp`insert into paste.pastes (slug, owner_id, content, language, visibility) values (${slug()}, ${other.id}, 'x', 'text', 'public')`),
      ).rejects.toThrow(/row-level security/);
    });
    const d = await seed(owner.id, { deleted_at: past(1000) });
    await asUser(owner.id, async (tx) => {
      expect((await tx`update paste.pastes set deleted_at = null where slug = ${d} returning slug`).length).toBe(0);
      expect((await tx`update paste.pastes set title = 'edit' where slug = ${d} returning slug`).length).toBe(0);
      // owner still sees it for "My pastes"
      expect((await tx`select slug from paste.pastes where slug = ${d}`).length).toBe(1);
    });
    const ex = await seed(owner.id, { expires_at: past(1000) });
    await asUser(owner.id, async (tx) => {
      expect((await tx`select slug from paste.pastes where slug = ${ex}`).length).toBe(1);
    });
    await asUser(other.id, async (tx) => {
      expect((await tx`select slug from paste.pastes where slug in ${tx([d, ex])}`).length).toBe(0);
    });
  });

  it('reports: anon and authenticated can insert, nobody can select', async () => {
    await asAnon(async (tx) => {
      await tx`insert into paste.reports (paste_slug, reason, reporter_hash) values ('abcdefghij', 'spam', 'h')`;
      await expect(tx.savepoint((sp) => sp`select * from paste.reports`)).rejects.toThrow(/permission denied/);
    });
    const u = await createTestUser();
    await asUser(u.id, async (tx) => {
      await tx`insert into paste.reports (paste_slug, reason, reporter_hash) values ('abcdefghij', 'spam', 'h')`;
      await expect(tx.savepoint((sp) => sp`select * from paste.reports`)).rejects.toThrow(/permission denied/);
      await expect(tx.savepoint((sp) => sp`insert into paste.reports (paste_slug, reason, reporter_hash) values ('abcdefghij', ${'x'.repeat(2001)}, 'h')`)).rejects.toThrow();
    });
  });
});

describe('service', () => {
  it('getPaste returns live public/unlisted pastes without owner, null for expired/deleted/missing', async () => {
    const u = await createTestUser();
    const a = await seed(u.id, { title: 'A', visibility: 'unlisted', content: 'body' });
    const e = await seed(u.id, { expires_at: past(1000) });
    const d = await seed(u.id, { deleted_at: past(1000) });
    const p = await getPaste(a);
    expect(p).toMatchObject({ slug: a, title: 'A', content: 'body', visibility: 'unlisted' });
    expect(p).not.toHaveProperty('owner_id');
    expect(await getPaste(e)).toBeNull();
    expect(await getPaste(d)).toBeNull();
    expect(await getPaste('nope')).toBeNull();
    expect(await getPaste('abcdefghij')).toBeNull();
  });

  it('searchPublicPastes excludes unlisted, expired and deleted; filters language; escapes wildcards; newest first; 20 per page', async () => {
    const u = await createTestUser();
    const tag = `zq${randomBytes(4).toString('hex')}`;
    const pub = await seed(u.id, { title: `${tag} public`, language: 'powershell', created_at: past(5000) });
    const unl = await seed(u.id, { title: `${tag} unlisted`, visibility: 'unlisted' });
    await seed(u.id, { title: `${tag} expired`, expires_at: past(1000) });
    await seed(u.id, { title: `${tag} deleted`, deleted_at: past(1000) });
    const byContent = await seed(u.id, { title: 'plain', content: `line one ${tag}\nsecond`, language: 'bash', created_at: past(1000) });

    const r = await searchPublicPastes({ text: tag, page: 1 });
    expect(r.items.map((i) => i.slug)).toEqual([byContent, pub]); // newest first
    expect(r.items.map((i) => i.slug)).not.toContain(unl);
    expect(r.items[0].preview).toBe(`line one ${tag}`);
    expect(r.items[0]).not.toHaveProperty('content');
    expect((await searchPublicPastes({ text: tag, language: 'bash', page: 1 })).items.map((i) => i.slug)).toEqual([byContent]);
    expect((await searchPublicPastes({ text: tag.toUpperCase(), page: 1 })).items).toHaveLength(2); // case-insensitive

    // % and _ are literal
    const wild = await seed(u.id, { title: `${tag}_100%` });
    expect((await searchPublicPastes({ text: `${tag}_100%`, page: 1 })).items.map((i) => i.slug)).toEqual([wild]);
    expect((await searchPublicPastes({ text: `${tag}_1`, page: 1 })).items.map((i) => i.slug)).toEqual([wild]);
    expect((await searchPublicPastes({ text: `${tag}%`, page: 1 })).items).toEqual([]); // '%' is not a wildcard;
    expect((await searchPublicPastes({ text: `${tag}_100%`.slice(-4), page: 1 })).items.map((i) => i.slug)).toEqual([wild]); // only literal-% titles
    expect((await searchPublicPastes({ text: `${tag}\\`, page: 1 })).items).toEqual([]);
  });

  it('paginates 20 per page', async () => {
    const u = await createTestUser();
    const tag = `pg${randomBytes(4).toString('hex')}`;
    for (let i = 0; i < 25; i++) await seed(u.id, { title: `${tag} ${i}`, created_at: past(i * 1000) });
    const p1 = await searchPublicPastes({ text: tag, page: 1 });
    const p2 = await searchPublicPastes({ text: tag, page: 2 });
    expect(p1.items).toHaveLength(20);
    expect(p1.hasNext).toBe(true);
    expect(p2.items).toHaveLength(5);
    expect(p2.hasNext).toBe(false);
  });

  it('updatePasteFor / deletePasteFor are owner-only, logged without content, and delete is soft', async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const s = await seed(owner.id, { title: 'before', content: 'secret-ish body' });

    await expect(updatePasteFor(other.id, { slug: s, title: 'x' })).rejects.toThrow(/not found/i);
    await expect(deletePasteFor(other.id, s)).rejects.toThrow(/not found/i);

    const upd = await updatePasteFor(owner.id, { slug: s, title: ' after ', content: 'new body', language: 'bash', visibility: 'unlisted', expiresAt: future(86400_000).toISOString() });
    expect(upd).toMatchObject({ slug: s, title: 'after', content: 'new body', language: 'bash', visibility: 'unlisted' });
    expect(upd.expires_at).not.toBeNull();
    await expect(updatePasteFor(owner.id, { slug: s, content: '   ' })).rejects.toThrow();
    await expect(updatePasteFor(owner.id, { slug: s, content: 'a\0b' })).rejects.toThrow();
    await expect(updatePasteFor(owner.id, { slug: s, expiresAt: past(1000).toISOString() })).rejects.toThrow();
    const cleared = await updatePasteFor(owner.id, { slug: s, expiresAt: null });
    expect(cleared.expires_at).toBeNull();

    const mine = await listMyPastes(owner.id);
    expect(mine.map((m) => m.slug)).toContain(s);
    expect(mine[0]).not.toHaveProperty('content');
    expect(await listMyPastes(other.id)).toEqual([]);

    await deletePasteFor(owner.id, s);
    const [row] = await sql`select deleted_at, content from paste.pastes where slug = ${s}`;
    expect(row.deleted_at).not.toBeNull(); // soft delete: row remains
    expect(await getPaste(s)).toBeNull();
    await expect(deletePasteFor(owner.id, s)).rejects.toThrow(/not found/i);
    await expect(updatePasteFor(owner.id, { slug: s, title: 'zombie' })).rejects.toThrow(/not found/i);
    expect((await listMyPastes(owner.id)).find((m) => m.slug === s)?.deleted_at).not.toBeNull();

    const acts = await sql`select action, entity_type, entity_id, meta from activity_log where entity_id = ${s} order by created_at`;
    expect(acts.map((a) => a.action)).toEqual(expect.arrayContaining(['paste.update', 'paste.delete']));
    expect(acts.every((a) => a.entity_type === 'paste')).toBe(true);
    expect(JSON.stringify(acts)).not.toContain('new body');
    expect(JSON.stringify(acts)).not.toContain('secret-ish');
  });
});
