import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { testDatabaseUrl } from '../db/env';

const sql = postgres(testDatabaseUrl(), { max: 2, onnotice: () => {} });
test.afterAll(async () => {
  await sql.end();
});

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const slug = () => Array.from(randomBytes(10), (b) => ALPHABET[b % 64]).join('');
const tag = () => `e2e${randomBytes(4).toString('hex')}`;

async function owner(): Promise<string> {
  const id = randomUUID();
  await sql`insert into auth.users (id, email) values (${id}, ${`paste-${id}@example.test`})`;
  return id;
}

async function seed(
  ownerId: string,
  o: { title?: string; content?: string; language?: string; visibility?: string; expires_at?: Date | null; deleted_at?: Date | null } = {},
) {
  const s = slug();
  await sql`insert into paste.pastes (slug, owner_id, title, content, language, visibility, expires_at, deleted_at)
    values (${s}, ${ownerId}, ${o.title ?? 'Seeded'}, ${o.content ?? 'echo hi'}, ${o.language ?? 'bash'}, ${o.visibility ?? 'public'}, ${o.expires_at ?? null}, ${o.deleted_at ?? null})`;
  return s;
}

async function signInAs(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

test('public pastebin: empty state, header, and no app shell', async ({ page }) => {
  await sql`delete from paste.pastes`;
  await page.goto('/p');
  await expect(page.getByText('No public pastes yet')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0); // no sidebar
});

test('unlisted paste reachable by URL but absent from search and sitemap', async ({ page, request }) => {
  const o = await owner();
  const t = tag();
  const pub = await seed(o, { title: `${t} public`, content: 'Get-Date', language: 'powershell' });
  const unl = await seed(o, { title: `${t} hidden`, content: 'secret-ish line', visibility: 'unlisted' });

  await page.goto(`/p?q=${t}`);
  await expect(page.getByRole('link', { name: new RegExp(`${t} public`) })).toBeVisible();
  await expect(page.getByText(`${t} hidden`)).toHaveCount(0);
  // content search must not surface unlisted either
  await page.goto('/p?q=secret-ish');
  await expect(page.getByText('No pastes match')).toBeVisible();

  await page.goto(`/p/${unl}`);
  await expect(page.getByRole('heading', { name: `${t} hidden` })).toBeVisible();
  await expect(page.getByText('Unlisted', { exact: true })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow');
  await expect(page.locator('.paste-code')).toContainText('secret-ish line');

  await page.goto(`/p/${pub}`);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  await expect(page.getByText('Unlisted', { exact: true })).toHaveCount(0);

  const sitemap = await (await request.get('/sitemap.xml')).text();
  expect(sitemap).toContain(`/p/${pub}`);
  expect(sitemap).not.toContain(unl);
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toMatch(/Disallow: \/app/);
  expect(robots).toMatch(/Allow: \/p/);
});

test('expired, deleted and unknown pastes show the same 404', async ({ page, request }) => {
  const o = await owner();
  const expired = await seed(o, { expires_at: new Date(Date.now() - 1000) });
  const deleted = await seed(o, { deleted_at: new Date() });
  for (const s of [expired, deleted, slug(), 'bad']) {
    const res = await page.goto(`/p/${s}`);
    expect(res?.status()).toBe(404);
    await expect(page.getByText("This paste has expired or doesn't exist")).toBeVisible();
    expect((await request.get(`/p/${s}/raw`)).status()).toBe(404);
  }
});

test('raw endpoint: text/plain, nosniff, cache and robots headers, download filename', async ({ request }) => {
  const o = await owner();
  const html = '<script>alert(1)</script>\n<b>x</b>';
  const pub = await seed(o, { content: html, language: 'powershell' });
  const unl = await seed(o, { content: 'u', visibility: 'unlisted', language: 'markdown' });

  const r = await request.get(`/p/${pub}/raw`);
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toBe('text/plain; charset=utf-8');
  expect(r.headers()['x-content-type-options']).toBe('nosniff');
  expect(r.headers()['content-disposition']).toBe('inline');
  expect(r.headers()['cache-control']).toBe('no-cache');
  expect(r.headers()['etag']).toMatch(/^"[A-Za-z0-9_-]+"$/);
  expect((await request.get(`/p/${pub}/raw`, { headers: { 'if-none-match': r.headers()['etag'] } })).status()).toBe(304);
  expect(r.headers()['x-robots-tag']).toBeUndefined();
  expect(await r.text()).toBe(html);

  const d = await request.get(`/p/${pub}/raw?download=1`);
  expect(d.headers()['content-disposition']).toBe(`attachment; filename="${pub}.ps1"`);

  const u = await request.get(`/p/${unl}/raw`);
  expect(u.headers()['cache-control']).toBe('private, no-store');
  expect(u.headers()['x-robots-tag']).toBe('noindex');
  expect(u.headers()['x-content-type-options']).toBe('nosniff');
  expect((await request.get(`/p/${unl}/raw?download=1`)).headers()['content-disposition']).toBe(`attachment; filename="${unl}.md"`);
});

test('renders hostile paste content inert; a 50,000-character line scrolls or wraps without freezing', async ({ page }) => {
  const o = await owner();
  const dialogs: string[] = [];
  page.on('dialog', async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  const hostile = ['<script>alert(1)</script>', '</pre><img src=x onerror=alert(1)>', `"'><svg onload=alert(1)>`, '</code></pre></div><iframe src="javascript:alert(1)"></iframe>'].join('\n');
  for (const language of ['powershell', 'bash', 'text']) {
    const s = await seed(o, { title: '<img src=x onerror=alert(2)>', content: hostile, language });
    await page.goto(`/p/${s}`);
    const code = page.locator('.paste-code');
    await expect(code).toContainText('<script>alert(1)</script>');
    await expect(code).toContainText('</pre><img src=x onerror=alert(1)>');
    await expect(code.locator('script, img, svg, iframe')).toHaveCount(0);
    await expect(page.locator('main img, main iframe')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('<img src=x onerror=alert(2)>');
  }
  // listing preview is plain text too
  const t = tag();
  await seed(o, { title: t, content: '<img src=x onerror=alert(3)>' });
  await page.goto(`/p?q=${t}`);
  await expect(page.getByText('<img src=x onerror=alert(3)>')).toBeVisible();
  await expect(page.locator('main img')).toHaveCount(0);

  // 50,000-character line
  const long = await seed(o, { content: `${'A'.repeat(50_000)}\nshort`, language: 'bash' });
  const started = Date.now();
  await page.goto(`/p/${long}`);
  const pre = page.locator('.paste-code pre');
  await expect(pre).toBeVisible();
  expect(Date.now() - started).toBeLessThan(15_000);
  const scrolls = await pre.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(scrolls).toBe(true);
  await page.getByRole('button', { name: 'Wrap lines' }).click();
  await expect(page.getByRole('button', { name: 'Wrap lines' })).toHaveAttribute('aria-pressed', 'true');
  const wrapped = await pre.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(wrapped).toBe(true);

  // 512 KB paste: plain fallback, still fast and inert
  const big = await seed(o, { content: `<b>${'x'.repeat(524_000)}`, language: 'bash' });
  await page.goto(`/p/${big}`);
  await expect(page.getByText('too large to highlight')).toBeVisible();
  await expect(page.locator('.paste-code b')).toHaveCount(0);

  expect(dialogs).toEqual([]);
});

test('paste page actions: copy, share, download and raw link; owner sees Edit/Delete', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const email = `own-${randomUUID()}@example.test`;
  await signInAs(page, email);
  const [{ id }] = await sql`select id from auth.users where email = ${email}`;
  const mine = await seed(id, { content: 'line1\nline2', language: 'bash', title: 'Mine' });
  const theirs = await seed(await owner(), { content: 'x', title: 'Theirs' });

  await page.goto(`/p/${mine}`);
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('line1\nline2');
  await page.getByRole('button', { name: 'Share' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/p/${mine}$`));
  await expect(page.getByRole('link', { name: 'Raw' })).toHaveAttribute('href', `/p/${mine}/raw`);
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe(`${mine}.sh`);
  await expect(page.getByRole('link', { name: 'Edit' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Delete' })).toBeVisible();

  await page.goto(`/p/${theirs}`);
  await expect(page.getByRole('heading', { name: 'Theirs' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
});

test('My pastes: lists own pastes with status labels, edit and delete with confirm', async ({ page, request }) => {
  const email = `mine-${randomUUID()}@example.test`;
  await signInAs(page, email);
  const [{ id }] = await sql`select id from auth.users where email = ${email}`;
  const t = tag();
  const live = await seed(id, { title: `${t} live`, content: 'echo one', language: 'bash' });
  await seed(id, { title: `${t} old`, expires_at: new Date(Date.now() - 1000) });
  await seed(id, { title: `${t} gone`, deleted_at: new Date() });
  await seed(await owner(), { title: `${t} not mine` });

  await page.goto('/app/pastes');
  const row = (text: string) => page.getByRole('row').filter({ hasText: text });
  await expect(row(`${t} live`)).toBeVisible();
  await expect(row(`${t} old`)).toContainText('Expired');
  await expect(row(`${t} gone`)).toContainText('Deleted');
  await expect(row(`${t} not mine`)).toHaveCount(0);
  await expect(row(`${t} gone`).getByRole('button')).toHaveCount(0);

  // Edit: title, visibility and content (Monaco)
  await row(`${t} live`).getByRole('button', { name: /^Edit/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit paste' });
  await expect(dialog.getByLabel('Title')).toHaveValue(`${t} live`);
  await dialog.getByLabel('Title').fill(`${t} renamed`);
  await dialog.getByLabel('Visibility').selectOption('unlisted');
  await dialog.getByLabel('Expiry').selectOption('1d');
  await dialog.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\necho two');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();
  await expect(row(`${t} renamed`)).toContainText('Unlisted');
  await expect(row(`${t} renamed`)).toContainText('Expires');

  const raw = await request.get(`/p/${live}/raw`);
  expect(await raw.text()).toBe('echo one\necho two');
  expect(raw.headers()['x-robots-tag']).toBe('noindex');

  // Delete needs confirmation; cancel keeps it
  await row(`${t} renamed`).getByRole('button', { name: /^Delete/ }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete paste' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  expect((await request.get(`/p/${live}/raw`)).status()).toBe(200);

  await row(`${t} renamed`).getByRole('button', { name: /^Delete/ }).click();
  await page.getByRole('dialog', { name: 'Delete paste' }).getByRole('button', { name: 'Delete paste' }).click();
  await expect(row(`${t} renamed`)).toContainText('Deleted');
  await expect(row(`${t} renamed`).getByRole('button')).toHaveCount(0);
  expect((await request.get(`/p/${live}/raw`)).status()).toBe(404);
  const res = await page.goto(`/p/${live}`);
  expect(res?.status()).toBe(404);
  const acts = await sql`select action from activity_log where entity_id = ${live} order by created_at`;
  expect(acts.map((a) => a.action)).toEqual(['paste.update', 'paste.delete']);
});
