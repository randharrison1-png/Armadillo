import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(`e2e-${randomUUID()}@example.test`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

async function createScript(page: Page, s: { name: string; filename: string; content?: string; description?: string }) {
  await page.getByRole('button', { name: 'Create script' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create script' });
  await dialog.getByLabel('Filename').fill(s.filename);
  await dialog.getByLabel('Name', { exact: true }).fill(s.name);
  if (s.description) await dialog.getByLabel('Description').fill(s.description);
  if (s.content) await dialog.getByLabel('Content').fill(s.content);
  await dialog.getByRole('button', { name: 'Create script' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row').filter({ hasText: s.name })).toBeVisible();
}

const rowFor = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

test('new account shows "No scripts in your library"', async ({ page }) => {
  await signIn(page);
  await page.goto('/app/library');
  await expect(page.getByText('No scripts in your library')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload file' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create script' })).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'Windows (0)' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Linux (0)' })).toBeVisible();
});

test('uploaded .ps1 appears under Windows with filename and version 1', async ({ page }) => {
  await signIn(page);
  await page.goto('/app/library');
  await page.getByRole('button', { name: 'Upload file' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload script' });
  await dialog.getByLabel('File').setInputFiles(path.join(FIXTURES, 'utf8-bom.ps1'));
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('utf8-bom'); // default: filename without extension
  await expect(dialog.getByRole('combobox', { name: 'Category' })).toHaveText('Windows');
  await expect(dialog.getByRole('combobox', { name: 'Function' })).toHaveText('Universal hardening');
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(dialog).toBeHidden();

  const row = rowFor(page, 'utf8-bom.ps1');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Windows');
  await expect(row).toContainText('v1');
  await expect(nav(page).getByRole('link', { name: 'Windows (1)' })).toBeVisible();

  // The sidebar child filters the library and shows as active.
  await nav(page).getByRole('link', { name: 'Windows (1)' }).click();
  await expect(page).toHaveURL(/\/app\/library\?category=windows$/);
  await expect(rowFor(page, 'utf8-bom.ps1')).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Windows (1)' })).toHaveClass(/bg-surface-raised/);
  await nav(page).getByRole('link', { name: 'Linux (0)' }).click();
  await expect(page.getByText('No scripts match')).toBeVisible();
});

test('upload rejects unsupported files inline and recovers', async ({ page }) => {
  await signIn(page);
  await page.goto('/app/library');
  await page.getByRole('button', { name: 'Upload file' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload script' });
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Choose a file');
  await dialog.getByLabel('File').setInputFiles(path.join(FIXTURES, 'sample.exe'));
  await expect(dialog.getByRole('alert')).toContainText('Unsupported file type');
  await dialog.getByLabel('File').setInputFiles(path.join(FIXTURES, 'lf.sh'));
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByRole('combobox', { name: 'Category' })).toHaveText('Linux'); // inferred from .sh
});

test('create dialog validates inline', async ({ page }) => {
  await signIn(page);
  await page.goto('/app/library');
  await page.getByRole('button', { name: 'Create script' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create script' });
  await dialog.getByRole('button', { name: 'Create script' }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: 'Enter a name' })).toBeVisible();
  await expect(dialog.getByRole('alert').filter({ hasText: 'Enter a filename' })).toBeVisible();
  await dialog.getByLabel('Filename').fill('x.exe');
  await dialog.getByLabel('Name', { exact: true }).fill('X');
  await dialog.getByRole('button', { name: 'Create script' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Use one of');
  await expect(page.getByRole('row')).toHaveCount(0);
});

test('search matches script content, not just name', async ({ page }) => {
  await signIn(page);
  await page.goto('/app/library');
  await createScript(page, { name: 'Firewall baseline', filename: 'fw.ps1', content: 'Set-NetFirewallProfile -Profile Domain -Enabled True\n' });
  await createScript(page, { name: 'Unrelated', filename: 'other.ps1', content: 'Write-Host hello\n' });

  const search = page.getByRole('searchbox', { name: 'Search scripts' });
  await search.fill('Set-NetFirewallProfile');
  await expect(page).toHaveURL(/q=Set-NetFirewallProfile/);
  await expect(rowFor(page, 'Firewall baseline')).toBeVisible();
  await expect(rowFor(page, 'Unrelated')).toHaveCount(0);

  await search.fill('no-such-token-anywhere');
  await expect(page.getByText('No scripts match')).toBeVisible();
  await page.getByRole('link', { name: 'Clear filters' }).click();
  await expect(rowFor(page, 'Unrelated')).toBeVisible();
  await expect(search).toHaveValue('');
});

test('Copy creates a new script at v1 and leaves the source untouched', async ({ page }) => {
  await signIn(page);
  await page.goto('/app/library');
  await createScript(page, { name: 'Source script', filename: 'src.sh', content: 'echo source\n' });
  const source = rowFor(page, 'Source script').first();
  const updated = await source.getByRole('cell').nth(5).textContent();

  await source.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(rowFor(page, 'Source script (copy)')).toBeVisible();
  await expect(rowFor(page, 'Source script (copy)')).toContainText('v1');
  await expect(rowFor(page, 'Source script (copy)')).toContainText('src.sh');
  // Two rows now; the original is still v1 under its own name.
  await expect(page.getByRole('row').filter({ hasText: 'Source script' })).toHaveCount(2);
  const original = page.getByRole('row').filter({ hasText: 'Source script' }).filter({ hasNotText: '(copy)' });
  await expect(original).toContainText('v1');
  expect(await original.getByRole('cell').nth(5).textContent()).toBe(updated);
  await expect(nav(page).getByRole('link', { name: 'Linux (2)' })).toBeVisible();

  // Open shows the copied content.
  await rowFor(page, 'Source script (copy)').getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Source script (copy)' })).toBeVisible();
  await expect(page.getByLabel('Script content')).toContainText('echo source');
});

test('scope filter reveals nothing hidden by default; counts match the table', async ({ page }) => {
  await signIn(page);
  await page.goto('/app/library');
  for (const n of ['a', 'b', 'c', 'd']) await createScript(page, { name: `Linux ${n}`, filename: `${n}.sh` });
  await expect(nav(page).getByRole('link', { name: 'Linux (4)' })).toBeVisible();
  await nav(page).getByRole('link', { name: 'Linux (4)' }).click();
  await expect(page.getByRole('row')).toHaveCount(5); // header + 4
  await page.getByRole('combobox', { name: 'Scope' }).click();
  await page.getByRole('option', { name: 'Session-generated' }).click();
  await expect(page).toHaveURL(/scope=session/);
  await expect(page.getByText('No scripts match')).toBeVisible();
});

test('Use in Claude is disabled without a session, then adds the version to that session context', async ({ page }) => {
  await signIn(page);
  await page.goto('/app/library');
  await createScript(page, { name: 'Context script', filename: 'ctx.ps1', content: 'Get-Date\n' });
  const useInClaude = rowFor(page, 'Context script').getByRole('button', { name: 'Use in Claude' });
  await expect(useInClaude).toBeDisabled();
  await rowFor(page, 'Context script').locator('span[tabindex="0"]').focus();
  await expect(page.getByRole('tooltip').first()).toContainText('Create a session first');

  await page.goto('/app/sessions');
  await page.getByRole('button', { name: 'New session' }).first().click();
  await page.getByRole('dialog').getByLabel('Title').fill('Round 1');
  await page.getByRole('dialog').getByRole('button', { name: 'Create session' }).click();
  await expect(page).toHaveURL(/\/app\/sessions\/([0-9a-f-]{36})$/);
  const sessionId = page.url().split('/').pop()!;

  await page.goto('/app/library');
  await rowFor(page, 'Context script').getByRole('button', { name: 'Use in Claude' }).click();
  await page.getByRole('menuitem', { name: 'Round 1' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/sessions/${sessionId}$`));
  const stored = await page.evaluate((id) => window.localStorage.getItem(`armadillo.context.${id}`), sessionId);
  expect(JSON.parse(stored!)).toEqual([{ type: 'script_version', id: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
});

test("another user's script id is a 404", async ({ page, browser }) => {
  await signIn(page);
  await page.goto('/app/library');
  await createScript(page, { name: 'Private one', filename: 'p.sh', content: 'x' });
  await rowFor(page, 'Private one').getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/app\/library\/[0-9a-f-]{36}$/);
  const url = page.url();
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await signIn(other);
  expect((await other.goto(url))?.status()).toBe(404);
  await ctx.close();
});
