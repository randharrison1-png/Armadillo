import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { AnthropicMockClient, E2E_ANTHROPIC_MOCK_PORT } from '../support/anthropic-mock';

const mock = new AnthropicMockClient(`http://127.0.0.1:${E2E_ANTHROPIC_MOCK_PORT}`);

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(`e2e-${randomUUID()}@example.test`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

async function createLibraryScript(page: Page, name: string, content: string) {
  await page.goto('/app/library');
  await page.getByRole('button', { name: 'Create script' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create script' });
  await dialog.getByLabel('Filename').fill('guest.ps1');
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Content').fill(content);
  await dialog.getByRole('button', { name: 'Create script' }).click();
  await expect(dialog).toBeHidden();
}

async function newSession(page: Page, title: string) {
  await page.goto('/app');
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Create session' }).click();
  await expect(page).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
}

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });

async function showInspector(page: Page) {
  const show = page.getByRole('button', { name: 'Show inspector' });
  if (await show.isVisible()) await show.click();
  await expect(inspector(page)).toBeVisible();
}

async function pasteReadme(page: Page, text: string) {
  await showInspector(page);
  await inspector(page).getByRole('button', { name: 'Add README' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add README' });
  await dialog.getByRole('tab', { name: 'Paste' }).click();
  await dialog.getByLabel('README text').fill(text);
  await dialog.getByRole('button', { name: 'Add README' }).click();
  await expect(dialog).toBeHidden();
}

const paragraphIds = (text: string) =>
  text.split('\n\n').map((p, i) => `p-${i}-${createHash('sha256').update(p.trim()).digest('hex').slice(0, 8)}`);

const panel = (page: Page) => page.getByRole('tabpanel');

test('assess → propose adaptation → diff tab → Accept gated on every flag → accept → session version downloadable, library script unchanged', async ({ page }) => {
  await signIn(page);
  await createLibraryScript(page, 'Guest hardening', "Write-Host 'start'\nWrite-Host 'end'");
  await newSession(page, 'Adaptation round');

  const token = `token-${randomUUID()}`;
  const readme = [`The guest account must be disabled (${token}).`, 'The print spooler is not needed.'].join('\n\n');
  const seg = paragraphIds(readme);
  await pasteReadme(page, readme);

  // Requirements: extract, then assess against the library script.
  await panel(page).getByRole('button', { name: 'Requirements' }).click();
  await mock.enqueue({
    match: token,
    toolUse: {
      input: {
        requirements: [
          { text: 'Disable the guest account', segment_id: seg[0], category: 'accounts', automatable: true, disruptive: true },
          { text: 'Disable the print spooler', segment_id: seg[1], category: 'services', automatable: true, disruptive: false },
        ],
      },
    },
  });
  await panel(page).getByRole('button', { name: 'Extract requirements' }).first().click();
  await expect(panel(page).getByRole('table', { name: 'Requirements' }).getByRole('row')).toHaveCount(3);

  await mock.enqueue({
    match: 'record_coverage',
    toolUse: {
      input: {
        assessments: [
          { requirement_id: 'R1', coverage: 'missing', suggestion: 'Disable-LocalUser -Name Guest', disruptive: true, automatable: true },
          { requirement_id: 'R2', coverage: 'missing', suggestion: 'Stop and disable Spooler', disruptive: false, automatable: true },
        ],
      },
    },
  });
  await panel(page).getByRole('button', { name: 'Assess coverage' }).click();
  const assess = page.getByRole('dialog', { name: 'Assess coverage' });
  await assess.getByLabel('Script version').selectOption({ label: 'Guest hardening · v1' });
  await assess.getByRole('button', { name: 'Assess coverage' }).click();
  await expect(panel(page).getByRole('table', { name: 'Requirements' }).getByText('Missing', { exact: true })).toHaveCount(2);

  // Propose an adaptation from the matrix toolbar: the assessed version is preselected.
  const adapted = ["Write-Host 'start'", 'Disable-LocalUser -Name Guest', 'Set-Service -Name Spooler -StartupType Disabled', "Write-Host 'end'"].join('\n');
  await mock.enqueue({
    match: 'record_adaptation',
    toolUse: {
      input: {
        content: adapted,
        summary: 'Disable Guest and the print spooler',
        flags: [
          { category: 'accounts', line: 2, reason: 'Guest is disabled as the README asks' },
          { category: 'other', line: 4, reason: 'Claude: confirm the run finishes' },
        ],
      },
    },
  });
  await panel(page).getByRole('button', { name: 'Propose adaptation' }).click();
  const propose = page.getByRole('dialog', { name: 'Propose adaptation' });
  await expect(propose.getByLabel('Script version')).toHaveValue(/[0-9a-f-]{36}/);
  await propose.getByRole('button', { name: 'Propose adaptation' }).click();
  await expect(propose).toBeHidden();

  // The proposal opens in a diff tab.
  await expect(page.getByRole('tab', { name: 'guest.ps1 · proposal' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).getByRole('heading', { name: /Guest hardening/ })).toBeVisible();
  await expect(panel(page).getByText('Disable Guest and the print spooler').first()).toBeVisible();
  await expect(panel(page).getByText(/library script is not changed/)).toBeVisible();
  await expect(panel(page).locator('.monaco-diff-editor')).toBeVisible();

  // Accept stays disabled until every high-impact change is acknowledged in the inspector checklist.
  await showInspector(page);
  const checklist = inspector(page).getByRole('region', { name: 'High-impact changes' });
  const boxes = checklist.getByRole('checkbox');
  await expect(boxes).toHaveCount(3);
  const accept = panel(page).getByRole('button', { name: /^Accept/ });
  await expect(accept).toHaveText('Accept (0 of 3 acknowledged)');
  await expect(accept).toBeDisabled();
  await checklist.getByRole('checkbox', { name: 'Acknowledge Accounts change on line 2' }).click();
  await checklist.getByRole('checkbox', { name: 'Acknowledge Services change on line 3' }).click();
  await expect(accept).toHaveText('Accept (2 of 3 acknowledged)');
  await expect(accept).toBeDisabled();
  await checklist.getByRole('button', { name: 'Go to line 4' }).click();
  await checklist.getByRole('checkbox', { name: 'Acknowledge Other change on line 4' }).click();
  await expect(accept).toHaveText('Accept (3 of 3 acknowledged)');
  await expect(accept).toBeEnabled();

  await accept.click();
  await expect(panel(page).getByText(/Accepted as guest\.ps1 v2/)).toBeVisible();
  await expect(panel(page).getByRole('button', { name: /^Accept/ })).toHaveCount(0);

  // The accepted version downloads as the file to run: UTF-8 with BOM, CRLF.
  const [download] = await Promise.all([page.waitForEvent('download'), panel(page).getByRole('link', { name: 'Download v2' }).click()]);
  const bytes = readFileSync(await download.path());
  expect(download.suggestedFilename()).toBe('guest.ps1');
  expect(bytes.equals(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(adapted.replace(/\n/g, '\r\n'), 'utf8')]))).toBe(true);

  // Reload: the proposal tab is restored, read-only, with its status.
  await page.reload();
  await expect(panel(page).getByText(/Accepted as guest\.ps1 v2/)).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Reject' })).toHaveCount(0);

  // The session copy opens from the proposal; the library script is still at v1.
  await panel(page).getByRole('button', { name: 'Open guest.ps1 v2' }).click();
  await expect(panel(page).getByText(/Session script/)).toBeVisible();
  await page.goto('/app/library');
  const row = page.getByRole('row').filter({ hasText: 'Guest hardening' });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('v1', { exact: true })).toBeVisible();
});

test('script tab → Propose adaptation → edits to the proposal are re-scanned → Reject saves nothing', async ({ page }) => {
  await signIn(page);
  await newSession(page, 'Editor round');
  const sessionUrl = page.url();
  await pasteReadme(page, `The firewall must be on (token-${randomUUID()}).`);
  await createLibraryScript(page, 'Firewall base', "Write-Host 'fw'");

  // Fork the library script into the session: its editor tab offers "Propose adaptation" (the session has a README).
  await page.getByRole('row').filter({ hasText: 'Firewall base' }).getByRole('link', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Fork to session' }).click();
  await page.getByRole('menuitem', { name: 'Editor round' }).click();
  await expect(page).toHaveURL(sessionUrl);
  await mock.enqueue({
    match: 'record_adaptation',
    toolUse: { input: { content: "Write-Host 'fw'\nSet-NetFirewallProfile -Profile Domain,Public,Private -Enabled True", summary: 'Turn the firewall on', flags: [] } },
  });
  await panel(page).getByRole('button', { name: 'Propose adaptation' }).click();
  await expect(page.getByRole('tab', { name: 'guest.ps1 · proposal' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).getByText(/Session script\. Accepting saves the right-hand side as v2/)).toBeVisible();

  await showInspector(page);
  const checklist = inspector(page).getByRole('region', { name: 'High-impact changes' });
  await expect(checklist.getByRole('checkbox')).toHaveCount(1);
  const accept = panel(page).getByRole('button', { name: /^Accept/ });
  await expect(accept).toHaveText('Accept (0 of 1 acknowledged)');

  // "Keep editing" focuses the proposed (right-hand) side; a new risky line there joins the checklist.
  const proposed = panel(page).getByRole('textbox', { name: 'guest.ps1 proposal, proposed version (editable)' });
  await expect(proposed).toBeAttached();
  await panel(page).getByRole('button', { name: 'Keep editing' }).click();
  await expect(proposed).toBeFocused();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Stop-Service -Name WinRM');
  await expect(checklist.getByText('Found in your edits')).toHaveCount(2);
  await expect(accept).toHaveText('Accept (0 of 3 acknowledged)');
  await checklist.getByRole('checkbox', { name: 'Acknowledge Firewall change on line 2' }).click();
  await expect(accept).toHaveText('Accept (1 of 3 acknowledged)');
  await expect(accept).toBeDisabled();

  // Reject asks first, then saves nothing.
  await panel(page).getByRole('button', { name: 'Reject' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reject this proposal?' });
  await expect(dialog.getByText(/your edits are discarded/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Reject proposal' }).click();
  await expect(panel(page).getByText('Rejected. Nothing was saved.')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: /^Accept/ })).toHaveCount(0);
  for (const box of await checklist.getByRole('checkbox').all()) await expect(box).toBeDisabled();

  // The session script is still at v1.
  await page.getByRole('tab', { name: /^guest\.ps1$/ }).click();
  await expect(panel(page).getByText('Saved as v1')).toBeVisible();
});
