import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { testDatabaseUrl } from '../db/env';
import { AnthropicMockClient, E2E_ANTHROPIC_MOCK_PORT } from '../support/anthropic-mock';

const sql = postgres(testDatabaseUrl(), { max: 2, onnotice: () => {} });
const mock = new AnthropicMockClient(`http://127.0.0.1:${E2E_ANTHROPIC_MOCK_PORT}`);
test.afterAll(async () => {
  await sql.end();
});

// playwright.config.ts: the server runs with LOCAL_FILE_STORE_DIR=.tmp/files relative to the repo root.
const FILE_ROOT = path.resolve('.tmp/files');

async function signIn(page: Page): Promise<{ email: string; id: string }> {
  const email = `e2e-${randomUUID()}@example.test`;
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
  const [u] = await sql<{ id: string }[]>`select id from auth.users where email = ${email}`;
  return { email, id: u!.id };
}

test('key field shows only ••••last4 after save', async ({ page }) => {
  await signIn(page);
  const key = `sk-ant-e2e-${randomUUID()}-LAST`;
  await page.goto('/app/settings');
  await page.getByLabel('Claude API key').fill(key);
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByTestId('claude-key-masked')).toHaveText('••••LAST');
  await expect(page.getByLabel('Claude API key')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('claude-key-masked')).toHaveText('••••LAST');
  const html = await page.content();
  expect(html).not.toContain(key);
  expect(html).not.toContain(key.slice(0, -4));
});

test('account, Claude and defaults settings persist; test connection reports the result', async ({ page }) => {
  const { id } = await signIn(page);
  await page.goto('/app/settings');

  // Password is managed by the provider under test auth.
  await expect(page.getByText('Password is managed by the test sign-in provider')).toBeVisible();

  await page.getByLabel('Display name').fill('Rand H');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByText('Display name saved.')).toBeVisible();

  await page.getByLabel('Default operating system').click();
  await page.getByRole('option', { name: 'Windows Server' }).click();
  await expect(page.getByText('Default operating system saved.')).toBeVisible();

  await page.getByLabel('Claude model').click();
  await page.getByRole('option', { name: 'claude-haiku-5-5' }).click();
  await expect(page.getByText('Model saved.')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Display name')).toHaveValue('Rand H');
  await expect(page.getByLabel('Default operating system')).toHaveText('Windows Server');
  await expect(page.getByLabel('Claude model')).toHaveText('claude-haiku-5-5');
  const [p] = await sql<{ display_name: string; default_os: string; model: string }[]>`select display_name, default_os, model from public.profiles where id = ${id}`;
  expect(p).toEqual({ display_name: 'Rand H', default_os: 'windows_server', model: 'claude-haiku-5-5' });

  // Test connection: ok, then an invalid key.
  await mock.reset();
  await mock.enqueue({ chunks: ['pong'] });
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByTestId('connection-result')).toHaveText(/Connected/);
  const req = (await mock.requests()).at(-1)!;
  expect((req.body as { max_tokens: number; model: string }).max_tokens).toBe(1);
  expect((req.body as { model: string }).model).toBe('claude-haiku-5-5');

  await mock.enqueue({ fail: { status: 401 } });
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByTestId('connection-result')).toHaveText(/rejected/);
});

test('privacy panel explains what Claude receives and export downloads a zip without the key', async ({ page }) => {
  const { id } = await signIn(page);
  const key = `sk-ant-e2e-${randomUUID()}-EXPT`;
  await sql`insert into paste.pastes (slug, owner_id, title, content, language) values (${randomBytes(8).toString('hex').slice(0, 10)}, ${id}, 'Exported paste', 'echo hi', 'bash')`;
  await page.goto('/app/settings');
  await page.getByLabel('Claude API key').fill(key);
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByTestId('claude-key-masked')).toBeVisible();

  const privacy = page.getByRole('region', { name: 'Privacy' });
  await expect(privacy.getByText(/only the items you select/i)).toBeVisible();
  await expect(privacy.getByText(/Nothing from your library is sent automatically/i)).toBeVisible();
  await expect(privacy.getByText(/pastes are public/i)).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), privacy.getByRole('link', { name: 'Export my data' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^armadillo-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const files = unzipSync(new Uint8Array(await readFile((await download.path())!)));
  expect(Object.keys(files)).toEqual(expect.arrayContaining(['data/profiles.json', 'data/pastes.json', 'manifest.json']));
  expect(JSON.parse(strFromU8(files['data/pastes.json']!))[0]).toMatchObject({ title: 'Exported paste' });
  const all = Object.values(files).map((f) => strFromU8(f)).join('\n');
  expect(all).toContain('EXPT');
  expect(all).not.toContain(key);
  expect(all).not.toContain('claude_key_ciphertext');
});

test('delete account removes private files and rows', async ({ page }) => {
  const { id } = await signIn(page);

  // Private data of every kind: a session (steps, history, activity rows), an uploaded file, a paste.
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await dialog.getByLabel('Title').fill('To be deleted');
  await dialog.getByRole('button', { name: 'Create session' }).click();
  await expect(page).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
  const sessionId = page.url().split('/').pop()!;
  const up = await page.evaluate(async (sid) => {
    const fd = new FormData();
    fd.append('kind', 'script');
    fd.append('sessionId', sid);
    fd.append('file', new File(['echo hi\n'], 'a.sh', { type: 'text/x-sh' }));
    const r = await fetch('/api/files/upload', { method: 'POST', body: fd });
    return (await r.json()) as { storagePath: string };
  }, sessionId);
  await sql`insert into public.workflow_step_events (owner_id, session_id, step, to_status) values (${id}, ${sessionId}, 'open_readme', 'in_progress')`;
  expect(up.storagePath.startsWith(`${id}/`)).toBe(true);
  expect(existsSync(path.join(FILE_ROOT, up.storagePath))).toBe(true);
  await sql`insert into paste.pastes (slug, owner_id, title, content, language) values (${randomBytes(8).toString('hex').slice(0, 10)}, ${id}, 'Mine', 'echo hi', 'bash')`;

  const owned = async () => ({
    users: (await sql`select 1 from auth.users where id = ${id}`).length,
    profiles: (await sql`select 1 from public.profiles where id = ${id}`).length,
    sessions: (await sql`select 1 from public.sessions where owner_id = ${id}`).length,
    steps: (await sql`select 1 from public.workflow_steps where owner_id = ${id}`).length,
    events: (await sql`select 1 from public.workflow_step_events where owner_id = ${id}`).length,
    activity: (await sql`select 1 from public.activity_log where owner_id = ${id}`).length,
    pastes: (await sql`select 1 from paste.pastes where owner_id = ${id}`).length,
  });
  // An activity_log row (insert-only) from a settings change.
  await page.goto('/app/settings');
  await page.getByLabel('Display name').fill('Doomed');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByText('Display name saved.')).toBeVisible();
  const before = await owned();
  for (const n of Object.values(before)) expect(n).toBeGreaterThan(0);

  await page.goto('/app/settings');
  await page.getByRole('button', { name: 'Delete account' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete account' });
  await expect(confirm.getByText(/pastes are deleted too/i)).toBeVisible();
  const go = confirm.getByRole('button', { name: 'Delete my account' });
  await expect(go).toBeDisabled();
  await confirm.getByLabel('Confirmation').fill('delete my acc');
  await expect(go).toBeDisabled();
  await confirm.getByLabel('Confirmation').fill('delete my account');
  await expect(go).toBeEnabled();
  await go.click();

  await expect(page).toHaveURL(/\/login\?notice=account-deleted$/);
  await expect(page.getByRole('status')).toHaveText(/account and its data were deleted/i);

  expect(await owned()).toEqual({ users: 0, profiles: 0, sessions: 0, steps: 0, events: 0, activity: 0, pastes: 0 });
  expect(existsSync(path.join(FILE_ROOT, up.storagePath))).toBe(false);
  expect(existsSync(path.join(FILE_ROOT, id))).toBe(false);

  // The old session no longer opens the app.
  await page.goto('/app/settings');
  await expect(page).toHaveURL(/\/login/);
});
