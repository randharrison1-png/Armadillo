import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAnon, asUser, createTestUser, sql } from './helpers';
import { buildGraph } from './coreFixtures';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { generateSlug, publishPaste, SlugCollisionError } from '@/features/pastebin/create';
import { PublishRefused } from '@/features/pastebin/publish';
import { reportPasteFor } from '@/features/pastebin/report';
import { updatePasteFor } from '@/features/pastebin/service';
import { SLUG_RE, type PublishPasteInput, type PublishRefusal } from '@/features/pastebin/schema';
import { checkRateLimit } from '@/server/security/rateLimit';
import { clientIp, reporterHash } from '@/server/security/abuse';
import { withUser } from '@/server/db/withUser';
import { resetEncryptionKeyCache } from '@/server/security/crypto';

beforeAll(() => {
  process.env.DATABASE_URL ??= testDatabaseUrl();
  process.env.KEY_ENCRYPTION_SECRET = 'db-test-key-encryption-secret-0123456789abcdef';
  resetEncryptionKeyCache();
});
afterAll(async () => {
  await closePool();
  await sql.end();
});

const AWS = 'AKIAIOSFODNN7EXAMPLE';
const base = (o: Partial<PublishPasteInput> = {}): PublishPasteInput => ({
  title: 'Harden SSH',
  content: 'echo hardened',
  language: 'bash',
  visibility: 'public',
  expiresIn: null,
  fromPrivate: false,
  acknowledgeSecrets: false,
  confirmPrivateSource: false,
  ...o,
});

async function refusal(p: Promise<unknown>): Promise<PublishRefusal> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PublishRefused) return e.refusal;
    throw e;
  }
  throw new Error('expected a refusal');
}

const pasteCount = async (owner: string) => (await sql`select count(*)::int as n from paste.pastes where owner_id = ${owner}`)[0].n as number;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const slugOf = () => Array.from(randomBytes(10), (b) => ALPHABET[b & 63]).join('');
async function seedPaste(owner: string, o: { content?: string; visibility?: string } = {}) {
  const s = slugOf();
  await sql`insert into paste.pastes (slug, owner_id, title, content, language, visibility) values (${s}, ${owner}, 'T', ${o.content ?? 'hello'}, 'text', ${o.visibility ?? 'public'})`;
  return s;
}
/** Pre-spends `count` hits of `key` in the current hour window (as the admin). */
async function spend(key: string, count: number, windowSec = 3600) {
  await sql`
    insert into rate_limit_hits (key, window_start, count)
    values (${key}, to_timestamp(floor(extract(epoch from clock_timestamp()) / ${windowSec}) * ${windowSec}), ${count})
    on conflict (key, window_start) do update set count = ${count}`;
}

describe('publishPaste', () => {
  it('publishes a clean paste: slug, row, and a content-free activity entry', async () => {
    const u = await createTestUser();
    const { slug } = await publishPaste(u.id, base({ content: 'Get-Date  # unmistakable body', language: 'powershell', expiresIn: '1d', visibility: 'unlisted' }));
    expect(slug).toMatch(SLUG_RE);
    const [row] = await sql`select owner_id, title, content, language, visibility, expires_at, from_private from paste.pastes where slug = ${slug}`;
    expect(row).toMatchObject({ owner_id: u.id, title: 'Harden SSH', language: 'powershell', visibility: 'unlisted', from_private: false });
    const ms = new Date(row.expires_at).getTime() - Date.now();
    expect(ms).toBeGreaterThan(86_400_000 - 60_000);
    expect(ms).toBeLessThanOrEqual(86_400_000);
    const acts = await sql`select action, entity_type, entity_id, meta from activity_log where entity_id = ${slug}`;
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ action: 'paste.publish', entity_type: 'paste' });
    expect(acts[0].meta).toEqual({ slug, visibility: 'unlisted', fromPrivate: false, secretsAcknowledged: false });
    expect(JSON.stringify(acts)).not.toContain('unmistakable');
  });

  it('rejects invalid input with a ZodError and writes nothing', async () => {
    const u = await createTestUser();
    await expect(publishPaste(u.id, base({ title: '   ' }))).rejects.toThrow();
    await expect(publishPaste(u.id, base({ content: '' }))).rejects.toThrow();
    await expect(publishPaste(u.id, base({ content: 'x'.repeat(512 * 1024 + 1) }))).rejects.toThrow();
    await expect(publishPaste(u.id, base({ language: 'ruby' as never }))).rejects.toThrow();
    await expect(publishPaste(u.id, base({ expiresIn: '2d' as never }))).rejects.toThrow();
    expect(await pasteCount(u.id)).toBe(0);
    // exactly 512 KB is accepted
    await publishPaste(u.id, base({ content: 'x'.repeat(512 * 1024) }));
  });

  it('secrets present and not acknowledged → refused, nothing stored or counted', async () => {
    const u = await createTestUser();
    const r = await refusal(publishPaste(u.id, base({ content: `a\nKEY=${AWS}\n` })));
    expect(r).toMatchObject({ code: 'secrets', findings: [{ kind: 'aws_access_key', line: 2 }] });
    expect((r as { fingerprint: string }).fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r)).not.toContain(AWS);
    expect(await pasteCount(u.id)).toBe(0);
    expect(await sql`select 1 from rate_limit_hits where key = ${`publish:${u.id}`}`).toHaveLength(0);
  });

  it('acknowledgement only counts with the matching fingerprint', async () => {
    const u = await createTestUser();
    const content = `KEY=${AWS}`;
    const r = (await refusal(publishPaste(u.id, base({ content })))) as Extract<PublishRefusal, { code: 'secrets' }>;

    // acknowledged but no fingerprint, or a wrong one → refused with FRESH findings
    for (const secretsFingerprint of [undefined, 'f'.repeat(64)]) {
      const again = await refusal(publishPaste(u.id, base({ content, acknowledgeSecrets: true, secretsFingerprint })));
      expect(again).toEqual(r);
    }
    // a fingerprint from earlier findings does not cover new ones
    const moved = await refusal(publishPaste(u.id, base({ content: `# new line\n${content}`, acknowledgeSecrets: true, secretsFingerprint: r.fingerprint })));
    expect(moved).toMatchObject({ code: 'secrets', findings: [{ kind: 'aws_access_key', line: 2 }] });
    expect((moved as { fingerprint: string }).fingerprint).not.toBe(r.fingerprint);
    // a matching fingerprint without acknowledgeSecrets is not an acknowledgement
    expect((await refusal(publishPaste(u.id, base({ content, secretsFingerprint: r.fingerprint })))).code).toBe('secrets');
    expect(await pasteCount(u.id)).toBe(0);

    const { slug } = await publishPaste(u.id, base({ content, acknowledgeSecrets: true, secretsFingerprint: r.fingerprint }));
    const [act] = await sql`select meta from activity_log where entity_id = ${slug}`;
    expect(act.meta.secretsAcknowledged).toBe(true);
    expect(JSON.stringify(act)).not.toContain(AWS);
  });

  it('fromPrivate without confirmPrivateSource → refused', async () => {
    const u = await createTestUser();
    expect(await refusal(publishPaste(u.id, base({ fromPrivate: true })))).toEqual({ code: 'private_source_unconfirmed' });
    expect(await pasteCount(u.id)).toBe(0);
    const { slug } = await publishPaste(u.id, base({ fromPrivate: true, confirmPrivateSource: true }));
    expect((await sql`select from_private from paste.pastes where slug = ${slug}`)[0].from_private).toBe(true);
  });

  it('published paste stores a copy, not a reference to the script', async () => {
    const u = await createTestUser();
    const g = await buildGraph(u.id);
    const [v] = await sql`select content from script_versions where id = ${g.universalV1}`;
    const { slug } = await publishPaste(u.id, base({ title: 'Copy', content: v.content, fromPrivate: true, confirmPrivateSource: true }));
    const [row] = await sql`select * from paste.pastes where slug = ${slug}`;
    expect(row.content).toBe(v.content);
    const values = Object.values(row).map((x) => String(x));
    for (const id of [g.universalScriptId, g.universalV1, g.sessionScriptId, g.sessionId]) expect(values).not.toContain(id);
    // the only uuid-typed values are the paste's own id and its owner
    const uuidCols = Object.entries(row).filter(([, x]) => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x)).map(([k]) => k);
    expect(uuidCols.sort()).toEqual(['id', 'owner_id']);
    // and the activity entry carries no source id either
    const [act] = await sql`select meta from activity_log where entity_id = ${slug}`;
    expect(JSON.stringify(act.meta)).not.toContain(g.universalScriptId);
    expect(JSON.stringify(act.meta)).not.toContain(g.universalV1);
    // editing the source afterwards does not touch the paste
    await sql`update scripts set name = 'renamed' where id = ${g.universalScriptId}`;
    expect((await sql`select content from paste.pastes where slug = ${slug}`)[0].content).toBe(v.content);
  });

  it('11th publish in an hour returns retryAfter', async () => {
    const u = await createTestUser();
    for (let i = 0; i < 10; i++) await publishPaste(u.id, base({ title: `p${i}` }));
    const r = await refusal(publishPaste(u.id, base({ title: 'eleventh' })));
    expect(r.code).toBe('rate_limited');
    const retryAfter = (r as { retryAfter: number }).retryAfter;
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect(await pasteCount(u.id)).toBe(10);
    // another user is unaffected
    const other = await createTestUser();
    await publishPaste(other.id, base());
  });

  it('edits and publishes have separate budgets', async () => {
    const u = await createTestUser();
    const unlisted = await seedPaste(u.id, { visibility: 'unlisted' });
    const pub = await seedPaste(u.id);
    await spend(`publish:${u.id}`, 10);

    // publishes are exhausted: a create and an unlisted -> public flip are refused...
    expect((await refusal(publishPaste(u.id, base()))).code).toBe('rate_limited');
    expect((await refusal(updatePasteFor(u.id, { slug: unlisted, visibility: 'public' }))).code).toBe('rate_limited');
    // ...but plain edits (including to a public paste) still work
    await updatePasteFor(u.id, { slug: pub, title: 'edited' });
    await updatePasteFor(u.id, { slug: unlisted, title: 'edited too' });
    await updatePasteFor(u.id, { slug: pub, visibility: 'unlisted' });

    // the edit budget is 60/hour
    await spend(`edit:${u.id}`, 60);
    expect((await refusal(updatePasteFor(u.id, { slug: pub, title: 'one too many' }))).code).toBe('rate_limited');
    await spend(`publish:${u.id}`, 9);
    const other = await createTestUser();
    expect(await pasteCount(other.id)).toBe(0);
    // publishes still have one left while edits are exhausted
    await publishPaste(u.id, base());
  });

  it('publish hits go into fixed windows aligned to the epoch', async () => {
    const u = await createTestUser();
    await publishPaste(u.id, base());
    const [h] = await sql`select window_start, count from rate_limit_hits where key = ${`publish:${u.id}`}`;
    expect(h.count).toBe(1);
    expect((new Date(h.window_start).getTime() / 1000) % 3600).toBe(0);
  });

  it('retries a slug collision with a fresh slug (up to 3 attempts)', async () => {
    const u = await createTestUser();
    const taken = await seedPaste(u.id);
    const fresh = slugOf();
    const queue = [taken, taken, fresh];
    const { slug } = await publishPaste(u.id, base(), { newSlug: () => queue.shift()! });
    expect(slug).toBe(fresh);
    expect(queue).toHaveLength(0);
    // a collision burns no rate-limit hit: only the successful attempt counts
    expect((await sql`select count from rate_limit_hits where key = ${`publish:${u.id}`}`)[0].count).toBe(1);

    let calls = 0;
    await expect(publishPaste(u.id, base(), { newSlug: () => (calls++, taken) })).rejects.toBeInstanceOf(SlugCollisionError);
    expect(calls).toBe(3);
  });

  it('slugs are 10 characters from crypto randomness', () => {
    const seen = new Set<string>();
    const chars = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const s = generateSlug();
      expect(s).toMatch(SLUG_RE);
      seen.add(s);
      for (const c of s) chars.add(c);
    }
    expect(seen.size).toBe(5000);
    expect(chars.size).toBe(64); // every symbol shows up, so no truncated alphabet
  });
});

describe('secrets and rate limits on edits (the publish seam)', () => {
  it('a content edit that adds a secret is refused unless acknowledged with its fingerprint', async () => {
    const u = await createTestUser();
    const s = await seedPaste(u.id, { content: 'clean' });
    const r = (await refusal(updatePasteFor(u.id, { slug: s, content: `x\n${AWS}` }))) as Extract<PublishRefusal, { code: 'secrets' }>;
    expect(r.findings).toEqual([{ kind: 'aws_access_key', line: 2 }]);
    expect((await sql`select content from paste.pastes where slug = ${s}`)[0].content).toBe('clean');
    expect((await refusal(updatePasteFor(u.id, { slug: s, content: `x\n${AWS}`, acknowledgeSecrets: true, secretsFingerprint: 'bad' }))).code).toBe('secrets');
    await updatePasteFor(u.id, { slug: s, content: `x\n${AWS}`, acknowledgeSecrets: true, secretsFingerprint: r.fingerprint });
    expect((await sql`select content from paste.pastes where slug = ${s}`)[0].content).toBe(`x\n${AWS}`);
  });

  it('flipping unlisted → public re-scans the stored content', async () => {
    const u = await createTestUser();
    const s = await seedPaste(u.id, { content: `password = "hunter2hunter2"`, visibility: 'unlisted' });
    const r = (await refusal(updatePasteFor(u.id, { slug: s, visibility: 'public' }))) as Extract<PublishRefusal, { code: 'secrets' }>;
    expect(r.findings).toEqual([{ kind: 'password_literal', line: 1 }]);
    expect((await sql`select visibility from paste.pastes where slug = ${s}`)[0].visibility).toBe('unlisted');
    await updatePasteFor(u.id, { slug: s, visibility: 'public', acknowledgeSecrets: true, secretsFingerprint: r.fingerprint });
    expect((await sql`select visibility from paste.pastes where slug = ${s}`)[0].visibility).toBe('public');
  });

  it('edits that leave content alone are not re-scanned (title, expiry, resubmitted identical content)', async () => {
    const u = await createTestUser();
    const s = await seedPaste(u.id, { content: AWS, visibility: 'public' });
    await updatePasteFor(u.id, { slug: s, title: 'renamed' });
    await updatePasteFor(u.id, { slug: s, content: AWS, title: 'renamed again' });
    await updatePasteFor(u.id, { slug: s, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    // but a real content change is
    expect((await refusal(updatePasteFor(u.id, { slug: s, content: `${AWS}\nmore` }))).code).toBe('secrets');
  });

  it('a refused update writes and logs nothing', async () => {
    const u = await createTestUser();
    const s = await seedPaste(u.id, { content: 'clean' });
    await refusal(updatePasteFor(u.id, { slug: s, content: AWS, title: 'nope' }));
    const [row] = await sql`select title, content from paste.pastes where slug = ${s}`;
    expect(row).toMatchObject({ title: 'T', content: 'clean' });
    expect(await sql`select 1 from activity_log where entity_id = ${s}`).toHaveLength(0);
  });
});

describe('check_rate_limit', () => {
  it('counts per key in fixed windows and resets in the next window', async () => {
    const u = await createTestUser();
    const key = `edit:${u.id}`;
    const hit = () => withUser(u.id, (tx) => checkRateLimit(tx, key, 2, 1));
    // (a 1-second window can roll over between two calls; retry the whole sequence once if it does)
    for (let attempt = 0; attempt < 3; attempt++) {
      await sql`delete from rate_limit_hits where key = ${key}`;
      const t0 = Date.now();
      const a = await hit();
      const b = await hit();
      const c = await hit();
      if (Date.now() - t0 > 400) continue;
      expect([a.ok, b.ok, c.ok]).toEqual([true, true, false]);
      expect(a.retryAfter).toBe(0);
      expect(c.retryAfter).toBe(1);
      await new Promise((r) => setTimeout(r, 1100));
      expect((await hit()).ok).toBe(true);
      return;
    }
    throw new Error('could not get a stable 1 s window');
  });

  it('keys are independent', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await withUser(a.id, (tx) => checkRateLimit(tx, `edit:${a.id}`, 1, 3600));
    expect((await withUser(a.id, (tx) => checkRateLimit(tx, `edit:${a.id}`, 1, 3600))).ok).toBe(false);
    expect((await withUser(b.id, (tx) => checkRateLimit(tx, `edit:${b.id}`, 1, 3600))).ok).toBe(true);
  });

  it('opportunistically deletes old windows', async () => {
    const u = await createTestUser();
    const old = `report:old-${u.id}`;
    await sql`insert into rate_limit_hits (key, window_start, count) values (${old}, now() - interval '3 days', 4)`;
    await withUser(u.id, async (tx) => {
      for (let i = 0; i < 400; i++) await checkRateLimit(tx, `report:cleanup-${u.id}`, 1000, 3600);
    });
    expect(await sql`select 1 from rate_limit_hits where key = ${old}`).toHaveLength(0);
    expect((await sql`select count from rate_limit_hits where key = ${`report:cleanup-${u.id}`}`)[0].count).toBe(400);
  });

  it('rejects bad arguments and keys a caller may not spend', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const call = (role: 'a' | 'anon', key: string, limit = 5, win = 60) =>
      role === 'anon'
        ? asAnon((tx) => tx`select * from public.check_rate_limit(${key}, ${limit}, ${win})`)
        : asUser(a.id, (tx) => tx`select * from public.check_rate_limit(${key}, ${limit}, ${win})`);
    await expect(call('a', `publish:${b.id}`)).rejects.toThrow(/key not allowed/); // someone else's budget
    await expect(call('a', 'whatever')).rejects.toThrow(/key not allowed/);
    await expect(call('anon', `publish:${a.id}`)).rejects.toThrow(/key not allowed/);
    await expect(call('anon', 'report:')).rejects.toThrow(/key not allowed/);
    await expect(call('a', `edit:${a.id}`, 0)).rejects.toThrow(/invalid limit/);
    await expect(call('a', `edit:${a.id}`, 5, 0)).rejects.toThrow(/invalid limit/);
    await expect(call('a', `edit:${a.id}`, 5, 86401)).rejects.toThrow(/invalid limit/);
    await expect(call('a', `report:${'x'.repeat(201)}`)).rejects.toThrow(/invalid key/);
    expect((await call('anon', 'report:abc'))[0].ok).toBe(true);
  });

  it('the table has no client grants and the function runs with an empty search_path', async () => {
    const u = await createTestUser();
    await expect(asUser(u.id, (tx) => tx`select * from rate_limit_hits`)).rejects.toThrow(/permission denied/);
    await expect(asUser(u.id, (tx) => tx`insert into rate_limit_hits (key, window_start, count) values ('x', now(), 1)`)).rejects.toThrow(/permission denied/);
    await expect(asAnon((tx) => tx`select * from rate_limit_hits`)).rejects.toThrow(/permission denied/);
    const [fn] = await sql`select prosecdef, proconfig from pg_proc where proname = 'check_rate_limit'`;
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toContain('search_path=""');
    const grants = await sql`select grantee from information_schema.routine_privileges where routine_name = 'check_rate_limit' and grantee in ('anon', 'authenticated', 'PUBLIC') order by grantee`;
    expect(grants.map((g) => g.grantee)).toEqual(['anon', 'authenticated']);
  });
});

describe('check_rate_limit under a non-superuser, non-BYPASSRLS owner (hosted-Supabase shape)', () => {
  it('works when the function owner cannot bypass RLS', async () => {
    const migration = readFileSync(join(import.meta.dirname, '..', '..', 'supabase', 'migrations', '0006_rate_limit.sql'), 'utf8');
    expect(migration).not.toMatch(/force row level security/i);
    await sql.unsafe(`
      drop schema if exists rlt cascade;
      do $$ begin
        if not exists (select from pg_roles where rolname = 'rl_owner') then create role rl_owner nologin nosuperuser nobypassrls; end if;
      end $$;
      create schema rlt authorization rl_owner;
      grant usage on schema auth to rl_owner;
      grant execute on function auth.uid(), auth.jwt() to rl_owner;
      grant usage on schema rlt to anon, authenticated;
    `);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe('set local role rl_owner');
        await tx.unsafe(migration.replaceAll('public.', 'rlt.'));
      });
      const u = await createTestUser();
      const hit = (key: string) => asUser(u.id, (tx) => tx`select * from rlt.check_rate_limit(${key}, 1, 3600)`);
      expect((await hit(`edit:${u.id}`))[0]).toMatchObject({ ok: true, retry_after: 0 });
      const second = (await hit(`edit:${u.id}`))[0];
      // asUser rolls back, so each call sees a fresh table; drive the 2nd hit in one transaction instead
      expect(second.ok).toBe(true);
      const both = await asUser(u.id, async (tx) => {
        await tx`select * from rlt.check_rate_limit(${`edit:${u.id}`}, 1, 3600)`;
        return tx`select * from rlt.check_rate_limit(${`edit:${u.id}`}, 1, 3600)`;
      });
      expect(both[0].ok).toBe(false);
      await expect(asUser(u.id, (tx) => tx`select * from rlt.rate_limit_hits`)).rejects.toThrow(/permission denied/);
    } finally {
      await sql.unsafe('drop schema if exists rlt cascade');
    }
  });
});

describe('abuse reports', () => {
  const ip = '203.0.113.9';

  it('stores a report for a live paste, signed out, keyed by hash (never the IP)', async () => {
    const owner = await createTestUser();
    const s = await seedPaste(owner.id);
    const hash = reporterHash(ip);
    expect(await reportPasteFor({ slug: s, reason: '  contains malware  ' }, hash)).toEqual({ status: 'stored' });
    const rows = await sql`select paste_slug, reason, reporter_hash from paste.reports where paste_slug = ${s}`;
    expect(rows).toEqual([{ paste_slug: s, reason: 'contains malware', reporter_hash: hash }]);
    expect(JSON.stringify(rows)).not.toContain(ip);
  });

  it('6th report in an hour from one IP hash is refused; another hash is not', async () => {
    const owner = await createTestUser();
    const s = await seedPaste(owner.id);
    const hash = reporterHash('198.51.100.77');
    for (let i = 0; i < 5; i++) expect((await reportPasteFor({ slug: s, reason: `r${i}` }, hash)).status).toBe('stored');
    const sixth = await reportPasteFor({ slug: s, reason: 'r5' }, hash);
    expect(sixth.status).toBe('rate_limited');
    expect((sixth as { retryAfter: number }).retryAfter).toBeGreaterThanOrEqual(1);
    expect(await sql`select 1 from paste.reports where reporter_hash = ${hash}`).toHaveLength(5);
    expect((await reportPasteFor({ slug: s, reason: 'other reporter' }, reporterHash('198.51.100.78'))).status).toBe('stored');
  });

  it('refuses unknown, deleted and expired pastes (and still counts the attempt)', async () => {
    const owner = await createTestUser();
    const del = await seedPaste(owner.id);
    await sql`update paste.pastes set deleted_at = now() where slug = ${del}`;
    const exp = await seedPaste(owner.id);
    await sql`update paste.pastes set expires_at = now() - interval '1 minute' where slug = ${exp}`;
    const hash = reporterHash('192.0.2.5');
    expect((await reportPasteFor({ slug: del, reason: 'x' }, hash)).status).toBe('not_found');
    expect((await reportPasteFor({ slug: exp, reason: 'x' }, hash)).status).toBe('not_found');
    expect((await reportPasteFor({ slug: slugOf(), reason: 'x' }, hash)).status).toBe('not_found');
    expect(await sql`select 1 from paste.reports where reporter_hash = ${hash}`).toHaveLength(0);
    expect((await sql`select count from rate_limit_hits where key = ${`report:${hash}`}`)[0].count).toBe(3);
  });

  it('validates the reason (1–2000 characters) and the slug', async () => {
    const owner = await createTestUser();
    const s = await seedPaste(owner.id);
    const hash = reporterHash('192.0.2.6');
    await expect(reportPasteFor({ slug: s, reason: '   ' }, hash)).rejects.toThrow();
    await expect(reportPasteFor({ slug: s, reason: 'x'.repeat(2001) }, hash)).rejects.toThrow();
    await expect(reportPasteFor({ slug: 'short', reason: 'x' }, hash)).rejects.toThrow();
    expect((await reportPasteFor({ slug: s, reason: 'x'.repeat(2000) }, hash)).status).toBe('stored');
  });
});

describe('reporter hash and client IP', () => {
  it('is a deterministic HMAC that does not contain the IP and depends on KEY_ENCRYPTION_SECRET', () => {
    const h = reporterHash('203.0.113.9');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(reporterHash('203.0.113.9')).toBe(h);
    expect(reporterHash('203.0.113.10')).not.toBe(h);
    expect(h).not.toContain('203');
    const prev = process.env.KEY_ENCRYPTION_SECRET;
    process.env.KEY_ENCRYPTION_SECRET = 'another-secret-another-secret-another-0123';
    resetEncryptionKeyCache();
    expect(reporterHash('203.0.113.9')).not.toBe(h);
    process.env.KEY_ENCRYPTION_SECRET = prev;
    resetEncryptionKeyCache();
  });

  it('uses the first X-Forwarded-For entry, else X-Real-IP, else one shared bucket', () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(clientIp(h({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' }))).toBe('203.0.113.9');
    expect(clientIp(h({ 'x-forwarded-for': ' 203.0.113.9 ', 'x-real-ip': '1.1.1.1' }))).toBe('203.0.113.9');
    expect(clientIp(h({ 'x-real-ip': '198.51.100.1' }))).toBe('198.51.100.1');
    expect(clientIp(h({}))).toBe('unknown');
  });
});
