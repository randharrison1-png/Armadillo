import { createHash, randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { AnthropicMockClient, E2E_ANTHROPIC_MOCK_PORT } from '../../support/anthropic-mock';

/**
 * Helpers shared by the e2e specs (formerly private copies in each spec). They only use roles,
 * labels and visible text, like the specs themselves.
 */

/** Drives the Anthropic mock that global-setup started (see tests/support/anthropic-mock.ts). */
export const mock = new AnthropicMockClient(`http://127.0.0.1:${E2E_ANTHROPIC_MOCK_PORT}`);

/** Signs in with the test auth provider (a new account unless `email` is given); returns the email. */
export async function signIn(page: Page, email = `e2e-${randomUUID()}@example.test`): Promise<string> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
  return email;
}

/** Creates a session from the dashboard and returns its id. */
export async function newSession(page: Page, title: string): Promise<string> {
  await page.goto('/app');
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Create session' }).click();
  await expect(page).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop()!;
}

export const inspector = (page: Page): Locator => page.getByRole('complementary', { name: 'Inspector' });
export const panel = (page: Page): Locator => page.getByRole('tabpanel');
/** A flowchart node button by its label (its accessible name is "<label>, <status>"). */
export const node = (page: Page, label: string): Locator => page.getByRole('button', { name: new RegExp(`^${label},`) });

/**
 * The Forensic questions panel of the selected flowchart node. Two ForensicPanels are mounted (the
 * node's "Step: Forensic questions" section and the session page's own "Forensic questions"
 * section), so this scopes to the node section's inner panel and is never ambiguous.
 */
export const forensicPanel = (page: Page): Locator =>
  inspector(page)
    .getByRole('region', { name: 'Step: Forensic questions', exact: true })
    .getByRole('region', { name: 'Forensic questions', exact: true });

export async function showInspector(page: Page) {
  const show = page.getByRole('button', { name: 'Show inspector' });
  if (await show.isVisible()) await show.click();
  await expect(inspector(page)).toBeVisible();
}

/** Pastes README text through the inspector's "Add README" dialog. */
export async function pasteReadme(page: Page, text: string) {
  await showInspector(page);
  await inspector(page).getByRole('button', { name: 'Add README' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add README' });
  await dialog.getByRole('tab', { name: 'Paste' }).click();
  await dialog.getByLabel('README text').fill(text);
  await dialog.getByRole('button', { name: 'Add README' }).click();
  await expect(dialog).toBeHidden();
}

/** Paragraph segment ids as the README extractor writes them (src/server/files/extract.ts). */
export const paragraphIds = (text: string) =>
  text.split('\n\n').map((p, i) => `p-${i}-${createHash('sha256').update(p.trim()).digest('hex').slice(0, 8)}`);

/** Creates a universal library script through the "Create script" dialog. */
export async function createLibraryScript(page: Page, name: string, content: string, filename = 'guest.ps1') {
  await page.goto('/app/library');
  await page.getByRole('button', { name: 'Create script' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create script' });
  await dialog.getByLabel('Filename').fill(filename);
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Content').fill(content);
  await dialog.getByRole('button', { name: 'Create script' }).click();
  await expect(dialog).toBeHidden();
}

export async function openFlowchart(page: Page) {
  await page.getByRole('tab', { name: 'Flowchart' }).click();
  await expect(page.getByTestId('flow-canvas')).toBeVisible();
}
