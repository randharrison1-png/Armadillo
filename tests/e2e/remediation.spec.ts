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
const panel = (page: Page) => page.getByRole('tabpanel');
const node = (page: Page, label: string) => page.getByRole('button', { name: new RegExp(`^${label},`) });

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

async function openFlowchart(page: Page) {
  await page.getByRole('tab', { name: 'Flowchart' }).click();
  await expect(page.getByTestId('flow-canvas')).toBeVisible();
}

async function uploadReport(page: Page, name: string, text: string) {
  await openFlowchart(page);
  await node(page, 'Run LEADS').click();
  await inspector(page).getByRole('button', { name: 'Open LEADS reports' }).click();
  await panel(page).getByLabel('LEADS report file').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await expect(page.getByRole('tab', { name: `Report · ${name}` })).toHaveAttribute('aria-selected', 'true');
}

async function suggestAndConfirm(page: Page, mappings: { finding: string; requirement: string | null }[]) {
  await mock.enqueue({ match: 'record_finding_mappings', toolUse: { input: { mappings } } });
  const evidence = panel(page).getByRole('region', { name: 'Verification evidence' });
  await evidence.getByRole('button', { name: 'Suggest mappings' }).click();
  await expect(evidence.getByRole('status')).toContainText(`Claude suggested a requirement for ${mappings.filter((m) => m.requirement).length} of`);
  return evidence;
}

const matrixRow = (page: Page, text: string) => panel(page).getByRole('table', { name: 'Requirements' }).getByRole('row').filter({ hasText: text });

test('failing report → targeted remediation → accept as a new script → confirm mappings → verify on a passing report → another cycle', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await createLibraryScript(page, 'Guest hardening', "Write-Host 'start'\nWrite-Host 'end'");
  await newSession(page, 'Remediation round');
  const sessionUrl = page.url();

  // README → requirements, assessed against the library script (both covered).
  const token = `token-${randomUUID()}`;
  const readme = [`The guest account must be disabled (${token}).`, 'The print spooler is not needed.'].join('\n\n');
  const seg = paragraphIds(readme);
  await pasteReadme(page, readme);
  await panel(page).getByRole('button', { name: 'Requirements' }).click();
  await mock.enqueue({
    match: token,
    toolUse: {
      input: {
        requirements: [
          { text: 'Disable the guest account', segment_id: seg[0], category: 'accounts', automatable: true, disruptive: false },
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
          { requirement_id: 'R1', coverage: 'covered', disruptive: false, automatable: true },
          { requirement_id: 'R2', coverage: 'covered', disruptive: false, automatable: true },
        ],
      },
    },
  });
  await panel(page).getByRole('button', { name: 'Assess coverage' }).click();
  const assess = page.getByRole('dialog', { name: 'Assess coverage' });
  await assess.getByLabel('Script version').selectOption({ label: 'Guest hardening · v1' });
  await assess.getByRole('button', { name: 'Assess coverage' }).click();
  await expect(panel(page).getByRole('table', { name: 'Requirements' }).getByText('Covered', { exact: true })).toHaveCount(2);

  // The session's hardening script: the library script forked into the session.
  await page.goto('/app/library');
  await page.getByRole('row').filter({ hasText: 'Guest hardening' }).getByRole('link', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Fork to session' }).click();
  await page.getByRole('menuitem', { name: 'Remediation round' }).click();
  await expect(page).toHaveURL(sessionUrl);

  // A failing LEADS report.
  await uploadReport(page, 'fail.txt', '[-] Guest account is enabled\n[+] Print spooler is disabled\nScore: 50/100 points\n');
  await expect(panel(page).getByText(/written against Guest hardening · v1/)).toBeVisible();

  // Propose remediation: only the failing finding goes to Claude; the proposal opens in a diff tab.
  const remediation = "Disable-LocalUser -Name Guest\nWrite-Host 'remediated'";
  await mock.enqueue({ match: 'record_remediation', toolUse: { input: { content: remediation, summary: 'Disable the Guest account', flags: [] } } });
  await panel(page).getByRole('button', { name: 'Propose remediation' }).click();
  await expect(page.getByRole('tab', { name: 'Remediation — Cycle 1 · proposal' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).getByRole('heading', { name: 'Remediation — Cycle 1: targeted remediation' })).toBeVisible();
  await expect(panel(page).getByText(/new session script, “Remediation — Cycle 1” \(v1\)/)).toBeVisible();
  await expect(panel(page).getByText(/hardening script, for reference/)).toBeVisible();
  const sent = (await mock.requests()).at(-1)!;
  const sentText = JSON.stringify(sent.body);
  expect(sentText).toContain('Guest account is enabled');
  expect(sentText).toMatch(/type=\\"findings\\"/);
  expect(/type=\\"findings\\"[^<]*>([\s\S]*?)<\/untrusted_document/.exec(sentText)?.[1]).not.toContain('Print spooler');

  // Accept is gated on the scanner's flag; accepting creates the new script.
  await showInspector(page);
  const checklist = inspector(page).getByRole('region', { name: 'High-impact changes' });
  const accept = panel(page).getByRole('button', { name: /^Accept/ });
  await expect(accept).toBeDisabled();
  await checklist.getByRole('checkbox', { name: 'Acknowledge Accounts change on line 1' }).click();
  await accept.click();
  await expect(panel(page).getByText(/Accepted as remediation-cycle-1\.ps1 v1, a new session script \(Remediation — Cycle 1\)\. Guest hardening is unchanged\./)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), panel(page).getByRole('link', { name: 'Download v1' }).click()]);
  expect(download.suggestedFilename()).toBe('remediation-cycle-1.ps1');
  const bytes = readFileSync(await download.path());
  expect(bytes.equals(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(remediation.replace(/\n/g, '\r\n'), 'utf8')]))).toBe(true);

  // Map the failing report's findings: confirm one suggestion, then the rest in bulk; apply verification.
  await page.getByRole('tab', { name: 'Report · fail.txt' }).click();
  let evidence = await suggestAndConfirm(page, [
    { finding: 'F1', requirement: 'R1' },
    { finding: 'F2', requirement: 'R2' },
  ]);
  await expect(panel(page).getByText('Suggested:')).toHaveCount(2);
  await panel(page).getByRole('button', { name: 'Confirm mapping for Guest account is enabled' }).click();
  await expect(evidence.getByRole('button', { name: 'Confirm all suggestions (1)' })).toBeEnabled();
  await evidence.getByRole('button', { name: 'Confirm all suggestions (1)' }).click();
  await expect(panel(page).getByText('Suggested:')).toHaveCount(0);
  await evidence.getByRole('button', { name: 'Apply verification' }).click();
  await expect(evidence.getByRole('status')).toContainText('1 requirement verified by this report.');

  // Matrix: the spooler is Verified with this report as evidence; the guest account is marked failing.
  await page.getByRole('tab', { name: 'Requirements' }).click();
  await expect(matrixRow(page, 'Disable the print spooler').getByText('Verified', { exact: true })).toBeVisible();
  await expect(matrixRow(page, 'Disable the print spooler').getByText('Evidence: fail.txt · cycle 1')).toBeVisible();
  await expect(matrixRow(page, 'Disable the guest account').getByTestId('failing-marker')).toContainText('Failing in latest report');
  await expect(matrixRow(page, 'Disable the guest account').getByText('Verified', { exact: true })).toHaveCount(0);

  // A passing report after running the remediation verifies the guest account too.
  await uploadReport(page, 'pass.txt', '[+] Guest account is disabled\n[+] Print spooler is disabled\nScore: 100/100 points\n');
  evidence = await suggestAndConfirm(page, [
    { finding: 'F1', requirement: 'R1' },
    { finding: 'F2', requirement: 'R2' },
  ]);
  await evidence.getByRole('button', { name: 'Confirm all suggestions (2)' }).click();
  await evidence.getByRole('button', { name: 'Apply verification' }).click();
  await expect(evidence.getByRole('status')).toContainText('1 requirement verified by this report (1 already verified).');
  await page.getByRole('tab', { name: 'Requirements' }).click();
  await expect(matrixRow(page, 'Disable the guest account').getByText('Evidence: pass.txt · cycle 1')).toBeVisible();
  await expect(matrixRow(page, 'Disable the guest account').getByTestId('failing-marker')).toHaveCount(0);
  await expect(matrixRow(page, 'Disable the print spooler').getByText('Evidence: fail.txt · cycle 1')).toBeVisible();

  // Flowchart: the remediation step opens the remediation script; "Start another cycle" resets the loop.
  await openFlowchart(page);
  await node(page, 'Targeted remediation').click();
  await expect(inspector(page).getByRole('button', { name: 'Open remediation script' })).toBeVisible();
  await expect(node(page, 'Run LEADS')).toHaveAccessibleName('Run LEADS, In Progress');
  await page.getByRole('button', { name: 'Final point check, decision' }).click();
  await expect(inspector(page).getByRole('button', { name: 'Mark complete' })).toBeDisabled();
  await inspector(page).getByRole('button', { name: 'Start another cycle' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start another audit cycle?' });
  await expect(dialog.getByText(/Reports, scripts, proposals and the step history of cycle 1 are kept/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Start another cycle' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Hardening flowchart · Cycle 2\./)).toBeVisible();
  await expect(node(page, 'Run LEADS')).toHaveAccessibleName('Run LEADS, Not Started');
  await expect(node(page, 'Targeted remediation')).toHaveAccessibleName('Targeted remediation, Not Started');
  await expect(inspector(page).getByRole('region', { name: 'Audit cycles' })).toContainText('Cycle 1 · Continued to the next cycle · report fail.txt');
  await expect(inspector(page).getByRole('button', { name: 'Start another cycle' })).toBeDisabled();

  // A cycle-1 report can no longer start a remediation: it would belong to cycle 1.
  await page.getByRole('tab', { name: 'Report · pass.txt' }).click();
  const proposeOld = panel(page).getByRole('button', { name: 'Propose remediation' });
  await expect(proposeOld).toBeDisabled();
  await proposeOld.locator('xpath=..').hover();
  await expect(page.getByRole('tooltip').first()).toContainText('This report is from cycle 1. Propose a remediation from a report of the current cycle (2).');
  await openFlowchart(page);

  // The history is kept: Run LEADS lists its cycle 1 start and the cycle 2 reset.
  await node(page, 'Run LEADS').click();
  const history = inspector(page).getByRole('list', { name: 'Run LEADS history' });
  await expect(history.getByRole('listitem')).toHaveCount(2);
  await expect(history.getByRole('listitem').nth(0)).toContainText(/In Progress → Not Started\s*Cycle 2/);
  await expect(history.getByRole('listitem').nth(1)).toContainText(/Not Started → In Progress\s*Cycle 1/);
});
