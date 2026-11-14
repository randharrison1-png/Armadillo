import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(`e2e-${randomUUID()}@example.test`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

async function newSession(page: Page, title: string) {
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Create session' }).click();
  await expect(page).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
}

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });

async function openIntake(page: Page) {
  const show = page.getByRole('button', { name: 'Show inspector' });
  if (await show.isVisible()) await show.click();
  await inspector(page).getByRole('button', { name: 'Add README' }).click();
  return page.getByRole('dialog', { name: 'Add README' });
}

test('paste README then reload shows it in the session', async ({ page }) => {
  await signIn(page);
  await newSession(page, 'Paste readme');

  const dialog = await openIntake(page);
  await dialog.getByRole('tab', { name: 'Paste' }).click();
  await dialog.getByLabel('README text').fill('Authorized users: alice, bob.\n\nRemote Desktop must stay disabled.\n\n<script>window.__pwned = 1</script>');
  await dialog.getByRole('button', { name: 'Add README' }).click();
  await expect(dialog).toBeHidden();

  const panel = page.getByRole('tabpanel');
  await expect(page.getByRole('tab', { name: 'README' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Authorized users: alice, bob.')).toBeVisible();
  await expect(panel.getByText('Remote Desktop must stay disabled.')).toBeVisible();
  await expect(panel.getByText('Windows', { exact: true })).toBeVisible(); // session OS in the header
  // Untrusted text is shown as text, never as markup.
  await expect(panel.getByText('<script>window.__pwned = 1</script>')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

  // Reload: no re-entry needed.
  await page.reload();
  await expect(page.getByRole('tab', { name: 'README' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel').getByText('Authorized users: alice, bob.')).toBeVisible();

  // Even with the tab closed, the inspector still lists the README and reopens it.
  await page.getByRole('button', { name: 'Close README' }).click();
  await page.getByRole('button', { name: 'Show inspector' }).click();
  await inspector(page).getByRole('button', { name: /Open README/ }).first().click();
  await expect(page.getByRole('tabpanel').getByText('Remote Desktop must stay disabled.')).toBeVisible();
});

test('PDF README shows page markers "Page 3"', async ({ page }) => {
  await signIn(page);
  await newSession(page, 'Pdf readme');
  const dialog = await openIntake(page);
  await dialog.getByRole('tab', { name: 'Upload' }).click();
  await dialog.getByLabel('File').setInputFiles(path.join(FIXTURES, 'readme.pdf'));
  await dialog.getByRole('button', { name: 'Upload README' }).click();
  await expect(dialog).toBeHidden();

  const panel = page.getByRole('tabpanel');
  await expect(panel.getByText('Page 1', { exact: true })).toBeVisible();
  await expect(panel.getByText('Page 3', { exact: true })).toBeVisible();
  await expect(panel.getByText('Page three: remote desktop must remain disabled.')).toBeVisible();
  const page3 = panel.locator('#seg-page-3');
  await expect(page3).toContainText('Page 3');

  // A #seg-<id> URL hash scrolls to and briefly highlights that segment (same path openSegment uses).
  await page.goto(`${page.url()}#seg-page-3`);
  await page.reload();
  await expect(page.getByRole('tabpanel').locator('#seg-page-3')).toHaveAttribute('data-highlight', 'true');
  await expect(page.getByRole('tabpanel').locator('#seg-page-3')).not.toHaveAttribute('data-highlight', 'true', { timeout: 6000 });
});

test('scanned PDF shows "No extractable text — paste the README instead"', async ({ page }) => {
  await signIn(page);
  await newSession(page, 'Scanned readme');
  const dialog = await openIntake(page);
  await dialog.getByRole('tab', { name: 'Upload' }).click();
  await dialog.getByLabel('File').setInputFiles(path.join(FIXTURES, 'scanned.pdf'));
  await dialog.getByRole('button', { name: 'Upload README' }).click();
  await expect(dialog).toBeHidden();

  const panel = page.getByRole('tabpanel');
  await expect(panel.getByText('No extractable text — paste the README instead')).toBeVisible();
  // The empty-text README offers the paste path right there.
  await panel.getByRole('button', { name: 'Paste README' }).click();
  await expect(page.getByRole('dialog', { name: 'Add README' }).getByRole('tab', { name: 'Paste' })).toHaveAttribute('aria-selected', 'true');
});

test('intake sets open_readme to In Progress only when text was extracted', async ({ page }) => {
  await signIn(page);
  await newSession(page, 'Step state');
  await page.getByRole('button', { name: 'Show inspector' }).click();
  await expect(inspector(page).getByTestId('readme-step-status')).toHaveText('Not Started');

  const dialog = await openIntake(page);
  await dialog.getByRole('tab', { name: 'Upload' }).click();
  await dialog.getByLabel('File').setInputFiles(path.join(FIXTURES, 'scanned.pdf'));
  await dialog.getByRole('button', { name: 'Upload README' }).click();
  await expect(dialog).toBeHidden();
  await expect(inspector(page).getByTestId('readme-step-status')).toHaveText('Not Started');

  await inspector(page).getByRole('button', { name: 'Add README' }).click();
  const second = page.getByRole('dialog', { name: 'Add README' });
  await second.getByRole('tab', { name: 'Paste' }).click();
  await second.getByLabel('README text').fill('Real text.');
  await second.getByRole('button', { name: 'Add README' }).click();
  await expect(second).toBeHidden();
  await expect(inspector(page).getByTestId('readme-step-status')).toHaveText('In Progress');
  // Two READMEs listed; the newest is shown in the tab.
  await expect(inspector(page).getByRole('button', { name: /Open README/ })).toHaveCount(2);
  await expect(page.getByRole('tabpanel').getByText('Real text.')).toBeVisible();
});

test('intake shows an error for a file type that is not allowed and never records it', async ({ page }) => {
  await signIn(page);
  await newSession(page, 'Bad file');
  const dialog = await openIntake(page);
  await dialog.getByRole('tab', { name: 'Upload' }).click();
  await dialog.getByLabel('File').setInputFiles(path.join(FIXTURES, 'sample.exe'));
  await expect(dialog.getByRole('alert')).toContainText('.txt .md .pdf');
  await expect(dialog.getByRole('button', { name: 'Upload README' })).toBeDisabled();
});

test('a 5,000-paragraph README renders incrementally and a deep segment is still reachable', async ({ page }) => {
  await signIn(page);
  await newSession(page, 'Big readme');
  const paragraphs = Array.from({ length: 5000 }, (_, i) => `Paragraph number ${i} of the README.`);
  const dialog = await openIntake(page);
  await dialog.getByRole('tab', { name: 'Upload' }).click();
  await dialog.getByLabel('File').setInputFiles({ name: 'big.txt', mimeType: 'text/plain', buffer: Buffer.from(paragraphs.join('\n\n')) });
  await dialog.getByRole('button', { name: 'Upload README' }).click();
  await expect(dialog).toBeHidden();

  const panel = page.getByRole('tabpanel');
  await expect(panel.getByText('Paragraph number 0 of the README.')).toBeVisible();
  expect(await panel.locator('[id^="seg-p-"]').count()).toBeLessThanOrEqual(400);
  await expect(panel.getByText('Showing 400 of 5000 sections')).toBeVisible();
  await panel.getByRole('button', { name: 'Show more' }).click();
  await expect(panel.getByText('Showing 800 of 5000 sections')).toBeVisible();

  // Deep link to the last segment (same queue openSegment uses): it is rendered, scrolled to and highlighted.
  const last = paragraphs[4999]!;
  const id = `p-4999-${createHash('sha256').update(last).digest('hex').slice(0, 8)}`;
  await page.goto(`${page.url()}#seg-${id}`);
  await page.reload();
  const target = page.getByRole('tabpanel').locator(`#seg-${id}`);
  await expect(target).toHaveAttribute('data-highlight', 'true');
  await expect(target).toBeInViewport();
});
