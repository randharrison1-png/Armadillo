import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAnthropicMock, type AnthropicMock } from '../support/anthropic-mock';
import { createTestUser, sql } from './helpers';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { createSessionFor } from '@/features/sessions/service';
import { LocalFileStore, verifyLocalDownloadUrl, type FileStore } from '@/server/files/storage';

let current: { id: string; email: string };
vi.mock('@/server/auth', () => ({ requireUser: async () => current, getCurrentUser: async () => current, authMode: () => 'test' }));

const { saveClaudeKeyFor } = await import('@/server/claude/keys');
const { testClaudeConnection } = await import('@/server/claude/client');
const service = await import('@/features/settings/service');
const { buildAccountExport, createAccountExportLink, EXPORT_FILES_TOO_LARGE, EXPORT_OBJECT_NAME } = await import('@/features/settings/export');
const { deleteAccountFor, AccountDeletionError } = await import('@/features/settings/deleteAccount');
const actions = await import('@/features/settings/actions');
const { EXPORT_MAX_BYTES } = await import('@/features/settings/schema');

let mock: AnthropicMock;
let dir: string;
let store: LocalFileStore;
const ENV_KEY = 'env-test-key-0000';
const SIGNING_SECRET = 'db-test-signing-secret-0123456789abcdef';

beforeAll(async () => {
  process.env.DATABASE_URL ??= testDatabaseUrl();
  mock = await startAnthropicMock();
  process.env.ANTHROPIC_BASE_URL = mock.url;
  process.env.ANTHROPIC_API_KEY = ENV_KEY;
  process.env.KEY_ENCRYPTION_SECRET = 'db-test-key-encryption-secret-0123456789abcdef';
  process.env.CLAUDE_MAX_RETRIES = '0';
  delete process.env.CLAUDE_MODEL;
  dir = await mkdtemp(path.join(tmpdir(), 'armadillo-settings-'));
  store = new LocalFileStore(dir, SIGNING_SECRET);
});
afterAll(async () => {
  await mock.close();
  await closePool();
  await sql.end();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  mock.reset();
  process.env.ANTHROPIC_BASE_URL = mock.url;
  current = await createTestUser();
});

const actionsFor = async (id: string) => (await sql`select action, meta from public.activity_log where owner_id = ${id} order by created_at, id`) as unknown as { action: string; meta: Record<string, unknown> }[];

describe('preferences', () => {
  it('display name, default OS and model persist; null clears them', async () => {
    await service.updateDisplayNameFor(current.id, '  Rand  ');
    await service.updateDefaultOsFor(current.id, 'linux');
    await service.updateModelFor(current.id, 'claude-opus-5-5');
    expect(await service.getSettingsFor(current.id)).toMatchObject({ displayName: 'Rand', defaultOs: 'linux', model: 'claude-opus-5-5' });

    await service.updateDisplayNameFor(current.id, '   ');
    await service.updateDefaultOsFor(current.id, 'none');
    await service.updateModelFor(current.id, 'server-default');
    expect(await service.getSettingsFor(current.id)).toMatchObject({ displayName: null, defaultOs: null, model: null });
  });

  it('rejects invalid values and changes nothing', async () => {
    await expect(service.updateDisplayNameFor(current.id, 'x'.repeat(101))).rejects.toThrow(/100/);
    await expect(service.updateDefaultOsFor(current.id, 'beos')).rejects.toThrow();
    await expect(service.updateModelFor(current.id, 'gpt-4')).rejects.toThrow();
    expect(await service.getSettingsFor(current.id)).toMatchObject({ displayName: null, defaultOs: null, model: null });
  });

  it('logs each change without values that are secrets', async () => {
    await service.updateDisplayNameFor(current.id, 'Rand');
    await service.updateDefaultOsFor(current.id, 'windows');
    await service.updateModelFor(current.id, 'claude-haiku-5-5');
    expect((await actionsFor(current.id)).map((a) => a.action)).toEqual([
      'settings.display_name.updated',
      'settings.default_os.updated',
      'settings.model.updated',
    ]);
  });

  it('the saved model is used by the gateway', async () => {
    await service.updateModelFor(current.id, 'claude-haiku-5-5');
    mock.enqueue({ chunks: ['pong'] });
    const r = await testClaudeConnection(current.id);
    expect(r).toMatchObject({ status: 'ok', model: 'claude-haiku-5-5' });
    expect((mock.requests()[0]!.body as { model: string }).model).toBe('claude-haiku-5-5');
  });
});

describe('test connection', () => {
  it('ok with the user key, sending a minimal request', async () => {
    const key = 'sk-ant-user-key-abcd1234';
    await saveClaudeKeyFor(current.id, key);
    mock.enqueue({ chunks: ['pong'] });
    const r = await testClaudeConnection(current.id);
    expect(r).toMatchObject({ status: 'ok', source: 'user' });
    const req = mock.requests()[0]!;
    expect(req.apiKey).toBe(key);
    expect((req.body as { max_tokens: number }).max_tokens).toBe(1);
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it('invalid key on a 401, never echoing the key', async () => {
    const key = 'sk-ant-bad-key-wxyz9876';
    await saveClaudeKeyFor(current.id, key);
    mock.enqueue({ fail: { status: 401, message: `invalid x-api-key ${key}` } });
    const r = await testClaudeConnection(current.id);
    expect(r).toEqual({ status: 'invalid_key' });
  });

  it('network error when the API is unreachable', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'; // discard port: connection refused
    expect(await testClaudeConnection(current.id)).toEqual({ status: 'network' });
  });

  it('no_key when there is neither a user key nor a server key', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await testClaudeConnection(current.id)).toEqual({ status: 'no_key' });
    } finally {
      process.env.ANTHROPIC_API_KEY = saved;
    }
    expect(mock.requests()).toHaveLength(0);
  });
});

async function seedAccount(userId: string, s: FileStore) {
  const session = await createSessionFor(userId, { title: 'Export me', os: 'linux' });
  const slug = Array.from({ length: 10 }, () => 'abcdefghij'[Math.floor(Math.random() * 10)]).join('');
  await sql`insert into paste.pastes (slug, owner_id, title, content, language) values (${slug}, ${userId}, 'My paste', 'echo exported', 'bash')`;
  // Insert-only history: only the account-deletion cascade may remove it.
  await sql`insert into public.workflow_step_events (owner_id, session_id, step, to_status) values (${userId}, ${session.id}, 'open_readme', 'in_progress')`;
  const filePath = `${userId}/${session.id}/${randomUUID()}-readme.md`;
  await s.put(filePath, new TextEncoder().encode('# README bytes'), 'text/markdown');
  return { session, slug, filePath };
}

describe('export', () => {
  it('zips data/<table>.json and files/<path>, without the key ciphertext', async () => {
    const key = 'sk-ant-export-key-q1w2e3r4';
    await saveClaudeKeyFor(current.id, key);
    const [{ c }] = (await sql`select claude_key_ciphertext as c from public.profiles where id = ${current.id}`) as unknown as { c: string }[];
    const mine = await seedAccount(current.id, store);
    const other = await createTestUser();
    await seedAccount(other.id, store);
    // A previous export zip must never be packed into the next one.
    await store.put(`${current.id}/_exports/${EXPORT_OBJECT_NAME}`, new TextEncoder().encode('OLD-EXPORT'), 'application/zip');

    const out = await buildAccountExport(current.id, store);
    expect(out.filename).toMatch(/^armadillo-export-\d{4}-\d{2}-\d{2}\.zip$/);
    const files = unzipSync(out.bytes);
    const names = Object.keys(files);
    expect(names).toEqual(expect.arrayContaining(['data/profiles.json', 'data/sessions.json', 'data/pastes.json', 'data/activity_log.json', `files/${mine.filePath}`, 'manifest.json']));

    const json = (n: string) => JSON.parse(strFromU8(files[n]!)) as Record<string, unknown>[];
    expect(json('data/profiles.json')).toHaveLength(1);
    expect(json('data/profiles.json')[0]).toMatchObject({ id: current.id, claude_key_last4: key.slice(-4) });
    expect(json('data/profiles.json')[0]).not.toHaveProperty('claude_key_ciphertext');
    expect(json('data/sessions.json').map((r) => r.title)).toEqual(['Export me']);
    expect(json('data/pastes.json').map((r) => r.slug)).toEqual([mine.slug]);
    expect(strFromU8(files[`files/${mine.filePath}`]!)).toBe('# README bytes');

    // Nothing from the key or another account anywhere in the archive.
    expect(names.filter((n) => n.startsWith('files/') && !n.startsWith(`files/${current.id}/`))).toEqual([]);
    expect(names.some((n) => n.includes('_exports'))).toBe(false);
    for (const n of names) {
      const text = strFromU8(files[n]!);
      expect(text).not.toContain(c);
      expect(text).not.toContain(key);
      expect(text).not.toContain(other.id);
    }
  });

  it('refuses when private files exceed the in-memory cap', async () => {
    const big: FileStore = {
      ...store,
      put: store.put.bind(store),
      get: store.get.bind(store),
      removePrefix: store.removePrefix.bind(store),
      stat: async () => ({ size: EXPORT_MAX_BYTES + 1024 * 1024 }),
      list: async () => [`${current.id}/library/huge.bin`],
      signDownload: store.signDownload.bind(store),
    };
    await expect(buildAccountExport(current.id, big)).rejects.toMatchObject({ code: EXPORT_FILES_TOO_LARGE });
  });

  it('a near-cap account is refused with the too-large error, leaving room for zip overhead', async () => {
    const nearCap = (EXPORT_MAX_BYTES - 1) as number;
    const near: FileStore = {
      ...store,
      put: store.put.bind(store),
      get: store.get.bind(store),
      removePrefix: store.removePrefix.bind(store),
      stat: async () => ({ size: nearCap }),
      list: async () => [`${current.id}/library/a.bin`],
      signDownload: store.signDownload.bind(store),
    };
    // Data JSON and per-entry zip overhead push it over the cap: the user-facing error, not a failed upload.
    await expect(buildAccountExport(current.id, near)).rejects.toMatchObject({ code: EXPORT_FILES_TOO_LARGE });
  });

  it('counts the data JSON toward the cap too', async () => {
    await seedAccount(current.id, store);
    await expect(buildAccountExport(current.id, store, { maxBytes: 50 })).rejects.toMatchObject({ code: EXPORT_FILES_TOO_LARGE });
  });

  it('createAccountExportLink stores the zip under _exports (overwriting) and returns a signed, expiring URL', async () => {
    const mine = await seedAccount(current.id, store);
    const first = await createAccountExportLink(current.id, store);
    const second = await createAccountExportLink(current.id, store);
    const objectPath = `${current.id}/_exports/${EXPORT_OBJECT_NAME}`;
    expect((await store.list(current.id)).filter((p) => p.includes('_exports'))).toEqual([objectPath]);

    const files = unzipSync(await store.get(objectPath));
    expect(Object.keys(files)).toContain(`files/${mine.filePath}`);
    expect(Object.keys(files).some((n) => n.includes('_exports'))).toBe(false);

    for (const r of [first, second]) {
      expect(r.filename).toMatch(/^armadillo-export-\d{4}-\d{2}-\d{2}\.zip$/);
      const u = new URL(r.url, 'http://x');
      expect(verifyLocalDownloadUrl(u.searchParams, SIGNING_SECRET)).toMatchObject({ path: objectPath, filename: r.filename });
      // Expires after 10 minutes.
      const exp = Number(u.searchParams.get('exp'));
      expect(exp - Date.now() / 1000).toBeGreaterThan(9 * 60);
      expect(exp - Date.now() / 1000).toBeLessThanOrEqual(10 * 60 + 1);
      expect(verifyLocalDownloadUrl(u.searchParams, SIGNING_SECRET, (exp + 1) * 1000)).toBeNull();
    }
  });

  it('a deleted account takes its stored export with it', async () => {
    await createAccountExportLink(current.id, store);
    await deleteAccountFor(current.id, { store });
    expect(await store.list(current.id)).toEqual([]);
  });
});

const countRows = async (id: string) => {
  const t = async (q: PromiseLike<ArrayLike<unknown>>) => (await q).length;
  return {
    user: await t(sql`select 1 from auth.users where id = ${id}`),
    profile: await t(sql`select 1 from public.profiles where id = ${id}`),
    sessions: await t(sql`select 1 from public.sessions where owner_id = ${id}`),
    steps: await t(sql`select 1 from public.workflow_steps where owner_id = ${id}`),
    events: await t(sql`select 1 from public.workflow_step_events where owner_id = ${id}`),
    activity: await t(sql`select 1 from public.activity_log where owner_id = ${id}`),
    pastes: await t(sql`select 1 from paste.pastes where owner_id = ${id}`),
  };
};

describe('delete account', () => {
  it('removes private files, the auth user and every owned row (including insert-only and pastes)', async () => {
    await service.updateModelFor(current.id, 'claude-opus-5-5'); // activity_log row
    const mine = await seedAccount(current.id, store);
    const other = await createTestUser();
    const theirs = await seedAccount(other.id, store);
    const before = await countRows(current.id);
    expect(Object.values(before).every((n) => n > 0)).toBe(true);

    await deleteAccountFor(current.id, { store });

    expect(Object.values(await countRows(current.id)).every((n) => n === 0)).toBe(true);
    expect(await store.list(current.id)).toEqual([]);
    await expect(store.get(mine.filePath)).rejects.toThrow();
    // Another account is untouched.
    expect((await countRows(other.id)).user).toBe(1);
    expect(await store.get(theirs.filePath)).toBeDefined();
  });

  it('aborts with nothing deleted from the database when storage deletion fails, and can be retried', async () => {
    const mine = await seedAccount(current.id, store);
    const failing: FileStore = {
      ...store,
      put: store.put.bind(store),
      get: store.get.bind(store),
      stat: store.stat.bind(store),
      list: store.list.bind(store),
      removePrefix: async () => {
        throw new Error('storage unavailable');
      },
      signDownload: store.signDownload.bind(store),
    };
    await expect(deleteAccountFor(current.id, { store: failing })).rejects.toBeInstanceOf(AccountDeletionError);
    const after = await countRows(current.id);
    expect(after.user).toBe(1);
    expect(after.sessions).toBe(1);
    expect(after.pastes).toBe(1);
    expect(await store.get(mine.filePath)).toBeDefined();

    await deleteAccountFor(current.id, { store });
    expect((await countRows(current.id)).user).toBe(0);
  });

  it('does not delete the auth user when files remain after removal', async () => {
    await seedAccount(current.id, store);
    const lying: FileStore = {
      ...store,
      put: store.put.bind(store),
      get: store.get.bind(store),
      stat: store.stat.bind(store),
      list: store.list.bind(store),
      removePrefix: async () => {}, // claims success, removes nothing
      signDownload: store.signDownload.bind(store),
    };
    await expect(deleteAccountFor(current.id, { store: lying })).rejects.toBeInstanceOf(AccountDeletionError);
    expect((await countRows(current.id)).user).toBe(1);
  });

  it('the action requires the exact confirmation phrase and deletes nothing otherwise', async () => {
    await seedAccount(current.id, store);
    for (const bad of ['', 'delete', 'delete my account please', 'DELETE MY ACCOUNT now']) {
      expect(await actions.deleteAccountAction(bad)).toMatchObject({ ok: false });
    }
    expect((await countRows(current.id)).user).toBe(1);
  });
});

describe('default OS for new sessions', () => {
  it('getDefaultOsFor returns the saved default, or null', async () => {
    expect(await service.getDefaultOsFor(current.id)).toBeNull();
    await service.updateDefaultOsFor(current.id, 'linux');
    expect(await service.getDefaultOsFor(current.id)).toBe('linux');
  });
});
