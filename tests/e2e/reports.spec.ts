import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'leads');

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

const node = (page: Page, label: string) => page.getByRole('button', { name: new RegExp(`^${label},`) });

/** Flowchart -> Run LEADS -> "Open LEADS reports". */
async function openReports(page: Page) {
  await page.getByRole('tab', { name: 'Flowchart' }).click();
  await expect(page.getByTestId('flow-canvas')).toBeVisible();
  await node(page, 'Run LEADS').click();
  await page.getByRole('complementary', { name: 'Inspector' }).getByRole('button', { name: 'Open LEADS reports' }).click();
}

test('upload a LEADS report, filter findings, toggle Raw, send to Claude', async ({ page }) => {
  await signIn(page);
  await newSession(page, 'Reports e2e');
  await openReports(page);

  const panel = page.getByRole('tabpanel');
  await expect(panel.getByRole('heading', { name: 'No LEADS reports yet' })).toBeVisible();
  await panel.getByLabel('LEADS report file').setInputFiles(path.join(FIXTURES, 'sectioned.txt'));

  // The new report opens in its own tab.
  await expect(page.getByRole('tab', { name: /Report · sectioned\.txt/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Cycle 1')).toBeVisible();
  await expect(panel.getByText('Parser: generic')).toBeVisible();
  await expect(panel.getByText('Reported score:')).toContainText('84 / 100');
  await expect(panel.getByText(/not verified by Armadillo/)).toBeVisible();
  await expect(panel.getByLabel('Finding counts')).toHaveText('Fail 4 · Pass 4 · Unknown 1');

  const table = panel.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(10); // header + 9 findings
  await expect(table.getByText('Unauthorized user "mallory" is an administrator')).toBeVisible();

  // Filters: status, then severity.
  await panel.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Fail', exact: true }).click();
  await expect(table.getByRole('row')).toHaveCount(5);
  await panel.getByRole('combobox', { name: 'Severity' }).click();
  await page.getByRole('option', { name: 'Critical' }).click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByText('Blank password set for local account')).toBeVisible();

  // Raw toggle: monospace plain text, line numbers into the original file.
  await panel.getByRole('button', { name: 'Raw' }).click();
  const raw = panel.getByTestId('raw-text');
  await expect(raw).toContainText('FAIL [critical] Blank password set for local account');
  expect(await raw.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/JetBrains Mono/);
  await expect(panel.getByRole('table')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Raw' }).click();
  await expect(panel.getByRole('table')).toBeVisible();

  // Send to Claude: the Claude tab opens with this report selected.
  await panel.getByRole('button', { name: 'Send to Claude' }).click();
  await expect(page.getByRole('tab', { name: 'Claude' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('combobox', { name: 'Mode' })).toHaveText(/Remediation/);
  await expect(panel.getByRole('button', { name: /Context/ })).toContainText('1 selected');
  await panel.getByRole('button', { name: /Context/ }).click();
  await expect(panel.getByRole('checkbox', { name: /sectioned\.txt/ })).toBeChecked();

  // The step moved to In Progress, and the report is listed under its cycle.
  await page.getByRole('tab', { name: 'Flowchart' }).click();
  await expect(node(page, 'Run LEADS')).toHaveAccessibleName('Run LEADS, In Progress');
  await openReports(page);
  await expect(panel.getByRole('region', { name: 'Cycle 1' }).getByText('sectioned.txt')).toBeVisible();
});

test('HTML report is shown as text; an unknown format stays raw', async ({ page }) => {
  await signIn(page);
  await newSession(page, 'Reports html');
  await openReports(page);
  const panel = page.getByRole('tabpanel');

  await panel.getByLabel('LEADS report file').setInputFiles(path.join(FIXTURES, 'report.html'));
  await expect(page.getByRole('tab', { name: /Report · report\.html/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Remote Desktop & Assistance is enabled')).toBeVisible();
  await expect(panel.getByText('Reported score:')).toContainText('67 / 100');
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect(page.locator('script', { hasText: '__pwned' })).toHaveCount(0);

  // Back to the list, upload an unknown-format file: no findings, the raw text is shown.
  await page.getByRole('tab', { name: 'Flowchart' }).click();
  await openReports(page);
  await panel.getByLabel('LEADS report file').setInputFiles(path.join(FIXTURES, 'unknown-format.txt'));
  await expect(page.getByRole('tab', { name: /Report · unknown-format\.txt/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Parser: raw')).toBeVisible();
  await expect(panel.getByTestId('raw-text')).toContainText('nobody has documented');
});

test('an unsupported file type is refused with a message', async ({ page }) => {
  await signIn(page);
  await newSession(page, 'Reports bad type');
  await openReports(page);
  const panel = page.getByRole('tabpanel');
  await panel.getByLabel('LEADS report file').setInputFiles({ name: 'run.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') });
  await expect(panel.getByRole('alert')).toContainText(/not supported|allowed|\.txt/i);
  await expect(panel.getByRole('heading', { name: 'No LEADS reports yet' })).toBeVisible();
});
