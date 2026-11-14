import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(`e2e-${randomUUID()}@example.test`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
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
}

async function openScript(page: Page, name: string) {
  await page.goto('/app/library');
  await page.getByRole('row').filter({ hasText: name }).getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/app\/library\/[0-9a-f-]{36}$/);
  await expect(editor(page)).toBeVisible();
}

const editor = (page: Page) => page.getByRole('region', { name: 'Script content' }).locator('.monaco-editor').first();
const history = (page: Page) => page.getByRole('region', { name: 'Version history' });

/** Appends a line at the end of the document in the Monaco editor. */
async function appendLine(page: Page, text: string) {
  await editor(page).locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
}

async function save(page: Page, note?: string) {
  if (note) await page.getByLabel('Change note').fill(note);
  await page.getByRole('button', { name: 'Save version' }).click();
}

test('compare v1 and v3 opens a diff tab without closing the editor tab', async ({ page }) => {
  await signIn(page);
  await createScript(page, { name: 'Diff me', filename: 'diff.sh', content: 'echo one' });
  await openScript(page, 'Diff me');
  const editorTab = page.getByRole('tab', { name: /^diff\.sh( Unsaved changes)?$/ });
  await expect(editorTab).toHaveAttribute('aria-selected', 'true');

  await appendLine(page, 'echo two');
  await expect(editorTab).toContainText('Unsaved changes');
  await save(page, 'second');
  await expect(history(page).getByRole('listitem').filter({ hasText: 'v2' })).toBeVisible();
  await expect(editorTab).not.toContainText('Unsaved changes');
  await appendLine(page, 'echo three');
  await save(page);
  await expect(history(page).getByRole('listitem')).toHaveCount(3);
  await expect(history(page).getByRole('listitem').first()).toContainText('v3');
  await expect(history(page).getByRole('listitem').filter({ hasText: 'v2' })).toContainText('second');

  // Saving identical content creates nothing.
  await save(page);
  await expect(page.getByText('No changes to save')).toBeVisible();
  await expect(history(page).getByRole('listitem')).toHaveCount(3);

  await history(page).getByRole('checkbox', { name: 'Select v1 for comparison' }).check();
  await history(page).getByRole('checkbox', { name: 'Select v3 for comparison' }).check();
  await history(page).getByRole('button', { name: 'Compare v1 and v3' }).click();

  const diffTab = page.getByRole('tab', { name: /v1 ↔ v3/ });
  await expect(diffTab).toHaveAttribute('aria-selected', 'true');
  await expect(editorTab).toBeVisible(); // the editor tab stays open
  await expect(page.getByRole('region', { name: 'Comparison of v1 and v3' })).toBeVisible();
  const comparison = page.getByRole('region', { name: 'Comparison of v1 and v3' });
  await expect(comparison.locator('.monaco-diff-editor')).toBeVisible();
  // Inserted-line decorations only appear once the (locally served) editor worker computed the diff.
  await expect(comparison.locator('.line-insert').first()).toBeVisible();
  await expect(page.getByText('+2 −0 lines')).toBeVisible();

  // Back to the editor: content and history still there.
  await editorTab.click();
  await expect(editor(page)).toContainText('echo three');
  await expect(history(page).getByRole('listitem')).toHaveCount(3);
});

test('stale save shows a conflict and never overwrites; "Save as new version based on v2" keeps both', async ({ page, context }) => {
  await signIn(page);
  await createScript(page, { name: 'Conflict me', filename: 'c.sh', content: 'echo base' });
  await openScript(page, 'Conflict me');
  const url = page.url();

  const other = await context.newPage();
  await other.goto(url);
  await expect(editor(other)).toBeVisible();
  await appendLine(other, 'echo from other tab');
  await save(other);
  await expect(history(other).getByRole('listitem')).toHaveCount(2);
  await other.close();

  await appendLine(page, 'echo mine');
  await save(page);
  const conflict = page.getByRole('alert').filter({ hasText: 'v2 was saved after you opened this' });
  await expect(conflict).toBeVisible();
  await expect(conflict.getByRole('button', { name: 'Open latest' })).toBeVisible();
  await conflict.getByRole('button', { name: 'Save as new version based on v2' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save as v3' }).click();
  await expect(history(page).getByRole('listitem')).toHaveCount(3);
  await expect(conflict).toBeHidden();
  await expect(editor(page)).toContainText('echo mine');

  // History is intact: v2 still holds the other tab's edit.
  await history(page).getByRole('listitem').filter({ hasText: 'v2' }).getByRole('button', { name: 'View v2' }).click();
  await expect(page.getByRole('tab', { name: 'c.sh v2', selected: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Script content' }).locator('.monaco-editor').first()).toContainText('echo from other tab');
});

test('"Open latest" discards local edits after confirmation', async ({ page, context }) => {
  await signIn(page);
  await createScript(page, { name: 'Latest me', filename: 'l.sh', content: 'echo base' });
  await openScript(page, 'Latest me');
  const other = await context.newPage();
  await other.goto(page.url());
  await appendLine(other, 'echo theirs');
  await save(other);
  await expect(history(other).getByRole('listitem')).toHaveCount(2);
  await other.close();

  await appendLine(page, 'echo mine');
  await save(page);
  await page.getByRole('alert').getByRole('button', { name: 'Open latest' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard my changes' }).click();
  await expect(editor(page)).toContainText('echo theirs');
  await expect(editor(page)).not.toContainText('echo mine');
  await expect(history(page).getByRole('listitem')).toHaveCount(2);
});

test('download of an uploaded UTF-16LE + CRLF script is byte-identical, from the table and the history', async ({ page, browser }) => {
  await signIn(page);
  await page.goto('/app/library');
  await page.getByRole('button', { name: 'Upload file' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload script' });
  await dialog.getByLabel('File').setInputFiles(path.join(FIXTURES, 'utf16le-crlf.ps1'));
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(dialog).toBeHidden();
  const original = readFileSync(path.join(FIXTURES, 'utf16le-crlf.ps1'));

  const row = page.getByRole('row').filter({ hasText: 'utf16le-crlf.ps1' });
  const [fromTable] = await Promise.all([page.waitForEvent('download'), row.getByRole('link', { name: 'Download' }).click()]);
  expect(fromTable.suggestedFilename()).toBe('utf16le-crlf.ps1');
  expect(readFileSync(await fromTable.path()).equals(original)).toBe(true);

  await row.getByRole('link', { name: 'Open' }).click();
  await expect(editor(page)).toContainText("Write-Host 'hello'");
  await expect(page.getByText('UTF-16 LE · CRLF').first()).toBeVisible();
  const [fromHistory] = await Promise.all([
    page.waitForEvent('download'),
    history(page).getByRole('link', { name: 'Download v1' }).click(),
  ]);
  expect(readFileSync(await fromHistory.path()).equals(original)).toBe(true);

  // The route itself: headers, and 404 for malformed / unknown ids. Fetched from the page (the
  // test auth cookie is Secure, which Playwright's request API does not send over http).
  const href = await history(page).getByRole('link', { name: 'Download v1' }).getAttribute('href');
  const probe = (url: string) =>
    page.evaluate(async (u) => {
      const r = await fetch(u);
      return { status: r.status, headers: Object.fromEntries(r.headers.entries()) };
    }, url);
  const res = await probe(href!);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('application/octet-stream');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['cache-control']).toBe('private, no-store');
  expect(res.headers['content-disposition']).toBe(`attachment; filename="utf16le-crlf.ps1"; filename*=UTF-8''utf16le-crlf.ps1`);
  expect((await probe('/api/files/download/not-a-uuid')).status).toBe(404);
  expect((await probe(`/api/files/download/${randomUUID()}`)).status).toBe(404);

  // Signed out: no file, just the way to /login.
  const anon = await browser.newContext();
  const signedOut = await anon.request.get(new URL(href!, page.url()).toString(), { maxRedirects: 0 });
  expect(signedOut.status()).toBe(307);
  expect(signedOut.headers()['location']).toMatch(/\/login$/);
  await anon.close();
});

test('restore creates a new version and keeps history', async ({ page }) => {
  await signIn(page);
  await createScript(page, { name: 'Restore me', filename: 'r.sh', content: 'echo original' });
  await openScript(page, 'Restore me');
  await appendLine(page, 'echo changed');
  await save(page);
  await expect(history(page).getByRole('listitem')).toHaveCount(2);
  await history(page).getByRole('listitem').filter({ hasText: 'v1' }).getByRole('button', { name: 'Restore v1' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore as v3' }).click();
  await expect(history(page).getByRole('listitem')).toHaveCount(3);
  await expect(history(page).getByRole('listitem').first()).toContainText('Restored from v1');
  await expect(editor(page)).not.toContainText('echo changed');
});

test('edit details updates name and systems', async ({ page }) => {
  await signIn(page);
  await createScript(page, { name: 'Detail me', filename: 'd.ps1', content: 'Get-Date' });
  await openScript(page, 'Detail me');
  await page.getByRole('button', { name: 'Edit details' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit details' });
  await dialog.getByLabel('Name', { exact: true }).fill('');
  await dialog.getByRole('button', { name: 'Save details' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter a name');
  await dialog.getByLabel('Name', { exact: true }).fill('Detailed');
  await dialog.getByLabel('Windows Server').check();
  await dialog.getByRole('button', { name: 'Save details' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Detailed' })).toBeVisible();
  await expect(page.getByText('Windows, Windows Server')).toBeVisible();
});

test('fork to a session opens the session copy; closing a dirty tab asks first', async ({ page }) => {
  await signIn(page);
  await page.goto('/app/sessions');
  await page.getByRole('button', { name: 'New session' }).first().click();
  await page.getByRole('dialog').getByLabel('Title').fill('Fork round');
  await page.getByRole('dialog').getByRole('button', { name: 'Create session' }).click();
  await expect(page).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);

  await createScript(page, { name: 'Universal base', filename: 'u.sh', content: 'echo universal' });
  await openScript(page, 'Universal base');
  await page.getByRole('button', { name: 'Fork to session' }).click();
  await page.getByRole('menuitem', { name: 'Fork round' }).click();
  await expect(page).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
  const tab = page.getByRole('tab', { name: /^u\.sh( Unsaved changes)?$/, selected: true });
  await expect(tab).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Claude' })).toBeVisible();
  await expect(editor(page)).toContainText('echo universal');
  await expect(history(page).getByRole('listitem').first()).toContainText('Forked from Universal base v1');

  await appendLine(page, 'echo session only');
  await expect(tab).toContainText('Unsaved changes');
  await page.getByRole('button', { name: /Close u\.sh/ }).click();
  const confirm = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Keep editing' }).click();
  await expect(tab).toBeVisible();
  await page.getByRole('button', { name: /Close u\.sh/ }).click();
  await page.getByRole('dialog', { name: 'Discard unsaved changes?' }).getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByRole('tab', { name: /u\.sh/ })).toHaveCount(0);

  // The universal script is untouched: still v1 in the library.
  await page.goto('/app/library');
  await expect(page.getByRole('row').filter({ hasText: 'Universal base' })).toContainText('v1');
});
