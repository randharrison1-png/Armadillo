import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { testDatabaseUrl } from '../db/env';

const sql = postgres(testDatabaseUrl(), { max: 2, onnotice: () => {} });
test.afterAll(async () => {
  await sql.end();
});

const AWS = 'AKIAIOSFODNN7EXAMPLE';

async function signIn(page: Page, email = `pub-${randomUUID()}@example.test`, path = '/login') {
  await page.goto(path);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  return email;
}

async function createScript(page: Page, s: { name: string; filename: string; content: string }) {
  await page.goto('/app/library');
  await page.getByRole('button', { name: 'Create script' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create script' });
  await dialog.getByLabel('Filename').fill(s.filename);
  await dialog.getByLabel('Name', { exact: true }).fill(s.name);
  await dialog.getByLabel('Content').fill(s.content);
  await dialog.getByRole('button', { name: 'Create script' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row').filter({ hasText: s.name })).toBeVisible();
}

test('publish from the library: private-source confirmation, secret warning, publish anyway, paste visible; then a signed-out report', async ({ page, browser, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const email = await signIn(page);
  await expect(page).toHaveURL(/\/app$/);
  const name = `Harden SSH ${randomUUID().slice(0, 6)}`;
  await createScript(page, { name, filename: 'harden-ssh.sh', content: `#!/bin/bash\nexport AWS_ACCESS_KEY_ID=${AWS}\necho hardened` });

  // Nothing is published just by creating the script.
  const [{ id: userId }] = await sql`select id from auth.users where email = ${email}`;
  expect(await sql`select 1 from paste.pastes where owner_id = ${userId}`).toHaveLength(0);

  await page.getByRole('row').filter({ hasText: name }).getByRole('button', { name: 'Publish to pastebin' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish to pastebin' });
  await expect(dialog.getByLabel('Title')).toHaveValue(name);
  await expect(dialog.getByLabel('Language')).toHaveValue('bash');
  await expect(dialog.getByLabel('Content')).toHaveValue(/AWS_ACCESS_KEY_ID/);
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();

  // 1. secrets warning comes first: kind + line, never the key itself; nothing is published yet
  const warn = page.getByRole('dialog', { name: 'Check before publishing' });
  await expect(warn).toContainText('Line 2');
  await expect(warn).toContainText('AWS access key');
  await expect(warn).not.toContainText(AWS);
  await expect(page.getByRole('dialog', { name: 'Publish a copy from your private library?' })).toHaveCount(0);
  expect(await sql`select 1 from paste.pastes where owner_id = ${userId}`).toHaveLength(0);
  const publish = warn.getByRole('button', { name: 'Publish', exact: true });
  await expect(publish).toBeDisabled();
  await warn.getByRole('checkbox', { name: 'Publish anyway' }).click();
  await publish.click();

  // 2. then the private-source confirmation names the source
  const confirm = page.getByRole('dialog', { name: 'Publish a copy from your private library?' });
  await expect(confirm).toContainText(`Publishing a copy of ${name} v1 from your private library`);
  expect(await sql`select 1 from paste.pastes where owner_id = ${userId}`).toHaveLength(0);
  await confirm.getByRole('button', { name: 'Publish copy' }).click();

  // 3. success
  const done = page.getByRole('dialog', { name: 'Paste published' });
  const link = done.getByRole('link', { name: /^\/p\// });
  await expect(link).toBeVisible();
  const href = (await link.getAttribute('href'))!;
  await done.getByRole('button', { name: 'Copy link' }).click();
  await expect(done.getByRole('button', { name: 'Link copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`${href}$`));
  const slug = href.replace('/p/', '');

  const [row] = await sql`select * from paste.pastes where slug = ${slug}`;
  expect(row).toMatchObject({ title: name, language: 'bash', visibility: 'public', from_private: true, owner_id: userId });
  const [sc] = await sql`select id, current_version_id from scripts where name = ${name}`;
  expect(Object.values(row).map(String)).not.toContain(sc.id);
  expect(Object.values(row).map(String)).not.toContain(sc.current_version_id);

  // Visible to a signed-out visitor, who can report it.
  const anon = await browser.newContext();
  const visitor = await anon.newPage();
  await visitor.goto(`/p/${slug}`);
  await expect(visitor.getByRole('heading', { name })).toBeVisible();
  await expect(visitor.locator('.paste-code')).toContainText('echo hardened');
  await visitor.getByRole('button', { name: 'Report' }).click();
  const report = visitor.getByRole('dialog', { name: 'Report this paste' });
  await report.getByRole('button', { name: 'Send report' }).click();
  await expect(report.getByRole('alert')).toContainText('Tell us what is wrong');
  await report.getByLabel('Reason').fill('Contains a leaked AWS key');
  await report.getByRole('button', { name: 'Send report' }).click();
  await expect(visitor.getByRole('dialog', { name: 'Report sent' })).toContainText("Thanks — we'll review this paste.");
  const reports = await sql`select reason, reporter_hash from paste.reports where paste_slug = ${slug}`;
  expect(reports).toHaveLength(1);
  expect(reports[0].reason).toBe('Contains a leaked AWS key');
  expect(reports[0].reporter_hash).toMatch(/^[0-9a-f]{64}$/);
  await anon.close();
});

test('publish from the script editor tab uses the saved version and the same confirmation', async ({ page }) => {
  await signIn(page);
  const name = `Editor ${randomUUID().slice(0, 6)}`;
  await createScript(page, { name, filename: 'editor.sh', content: 'echo from the editor' });
  await page.getByRole('row').filter({ hasText: name }).getByRole('link', { name: name }).click();
  await page.getByRole('button', { name: 'Publish to pastebin' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish to pastebin' });
  await expect(dialog.getByLabel('Content')).toHaveValue('echo from the editor');
  await dialog.getByLabel('Visibility').selectOption('unlisted');
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Publish a copy from your private library?' })).toContainText(`Publishing a copy of ${name} v1 from your private library`);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(dialog).toBeVisible(); // can go back; still nothing published
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await sql`select 1 from paste.pastes p join auth.users u on u.id = p.owner_id where p.title = ${name}`).toHaveLength(0);
});

test('/p/new redirects signed-out visitors to sign in and back; publishing a clean paste needs no warning', async ({ page }) => {
  await page.goto('/p/new');
  await expect(page).toHaveURL(/\/login\?next=%2Fp%2Fnew$|\/login\?next=\/p\/new$/);
  await signIn(page, `new-${randomUUID()}@example.test`, '/login?next=/p/new');
  await expect(page).toHaveURL(/\/p\/new$/);
  const dialog = page.getByRole('dialog', { name: 'Publish to pastebin' });
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(dialog.getByText('Enter a title.')).toBeVisible();
  await expect(dialog.getByText('Content cannot be empty.')).toBeVisible();
  const title = `Clean ${randomUUID().slice(0, 6)}`;
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Content').fill('Get-Date');
  await dialog.getByLabel('Language').selectOption('powershell');
  await dialog.getByLabel('Visibility').selectOption('unlisted');
  await dialog.getByLabel('Expiry').selectOption('1d');
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  const done = page.getByRole('dialog', { name: 'Paste published' });
  await expect(done).toContainText('unlisted');
  await done.getByRole('link', { name: /^\/p\// }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText('Unlisted', { exact: true })).toBeVisible();
  await expect(page.getByText(/Expires /)).toBeVisible();
});

test('a safe ?next= only: off-site destinations are ignored after sign-in', async ({ page }) => {
  await signIn(page, `next-${randomUUID()}@example.test`, '/login?next=//evil.test');
  await expect(page).toHaveURL(/\/app$/);
});

test('rate limit: the 11th publish shows "Try again in N minutes" and publishes nothing', async ({ page }) => {
  const email = await signIn(page);
  const [{ id }] = await sql`select id from auth.users where email = ${email}`;
  await sql`
    insert into rate_limit_hits (key, window_start, count)
    values (${`publish:${id}`}, to_timestamp(floor(extract(epoch from clock_timestamp()) / 3600) * 3600), 10)`;
  await page.goto('/p/new');
  const dialog = page.getByRole('dialog', { name: 'Publish to pastebin' });
  await dialog.getByLabel('Title').fill('Over the limit');
  await dialog.getByLabel('Content').fill('echo hi');
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(/Try again in \d+ minutes?\./);
  expect(await sql`select 1 from paste.pastes where owner_id = ${id}`).toHaveLength(0);
});

test('editing a paste to add a secret needs the same acknowledgement', async ({ page }) => {
  const email = await signIn(page);
  const [{ id }] = await sql`select id from auth.users where email = ${email}`;
  const slug = `E${randomUUID().replaceAll('-', '').slice(0, 9)}`;
  await sql`insert into paste.pastes (slug, owner_id, title, content, language, visibility) values (${slug}, ${id}, 'Editable', 'echo clean', 'bash', 'public')`;
  await page.goto(`/app/pastes?edit=${slug}`);
  const dialog = page.getByRole('dialog', { name: 'Edit paste' });
  await expect(dialog.getByLabel('Title')).toHaveValue('Editable');
  await dialog.getByLabel('Visibility').selectOption('unlisted');
  await dialog.getByLabel('Title').fill('Editable v2');
  // inject the secret through the editor
  await dialog.locator('.monaco-editor').first().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(`\nKEY=${AWS}`);
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByText('This may contain secrets')).toBeVisible();
  await expect(dialog).toContainText('AWS access key');
  await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  expect((await sql`select content from paste.pastes where slug = ${slug}`)[0].content).toBe('echo clean');
  await dialog.getByRole('checkbox', { name: 'Publish anyway' }).click();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();
  const [row] = await sql`select content, visibility, title from paste.pastes where slug = ${slug}`;
  expect(row.content).toContain(AWS);
  expect(row).toMatchObject({ visibility: 'unlisted', title: 'Editable v2' });
});
