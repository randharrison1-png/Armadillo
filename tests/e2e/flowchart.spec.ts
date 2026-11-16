import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import postgres from 'postgres';
import { testDatabaseUrl } from '../db/env';
import { inspector, newSession, node, openFlowchart, signIn } from './support/helpers';

const sql = postgres(testDatabaseUrl(), { max: 2, onnotice: () => {} });
test.afterAll(async () => {
  await sql.end();
});

test('"Send LEADS report to Claude" opens Claude tab with the latest report selected', async ({ page }) => {
  const email = `e2e-${randomUUID()}@example.test`;
  await signIn(page, email);
  const sessionId = await newSession(page, 'Flow send report');
  const [{ id: ownerId }] = await sql<{ id: string }[]>`select id from auth.users where email = ${email}`;
  await sql`insert into public.leads_reports (owner_id, session_id, cycle_no, filename, raw_text, created_at)
            values (${ownerId}, ${sessionId}, 1, 'older-leads.txt', 'old', now() - interval '1 hour')`;
  await sql`insert into public.leads_reports (owner_id, session_id, cycle_no, filename, raw_text)
            values (${ownerId}, ${sessionId}, 1, 'latest-leads.txt', 'new')`;
  await page.reload();

  await openFlowchart(page);
  await page.getByRole('button', { name: 'Send LEADS report to Claude' }).click();

  await expect(page.getByRole('tab', { name: 'Claude' })).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByRole('tabpanel');
  // The empty draft switches to remediation mode and the latest report is the only selection.
  await expect(panel.getByRole('combobox', { name: 'Mode' })).toHaveText(/Remediation/);
  await expect(panel.getByRole('button', { name: /Context/ })).toContainText('1 selected');
  await panel.getByRole('button', { name: /Context/ }).click();
  await expect(panel.getByRole('checkbox', { name: /latest-leads\.txt/ })).toBeChecked();
  await expect(panel.getByRole('checkbox', { name: /older-leads\.txt/ })).not.toBeChecked();
});

test('Send LEADS report is disabled with a reason until a report exists', async ({ page }) => {
  await signIn(page, `e2e-${randomUUID()}@example.test`);
  await newSession(page, 'Flow no report');
  await openFlowchart(page);
  const action = page.getByRole('button', { name: 'Send LEADS report to Claude' });
  await expect(action).toHaveAttribute('aria-disabled', 'true');
  await action.click({ force: true });
  await expect(page.getByRole('tab', { name: 'Flowchart' })).toHaveAttribute('aria-selected', 'true');
});

test('reload restores statuses and notes; verified needs evidence; history lists changes', async ({ page }) => {
  await signIn(page, `e2e-${randomUUID()}@example.test`);
  await newSession(page, 'Flow persist');
  await openFlowchart(page);

  await node(page, 'Open README').click();
  const panel = inspector(page);
  await expect(panel.getByText('No evidence yet')).toBeVisible();
  await panel.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'In Progress' }).click();
  await expect(node(page, 'Open README')).toHaveAccessibleName('Open README, In Progress');
  await panel.getByLabel('Notes').fill('README pasted from the competition page');
  await panel.getByRole('button', { name: 'Save notes' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Open README history' }).getByText('Not Started → In Progress')).toBeVisible();

  // Evidence-bearing step: Complete and Verified is refused without evidence.
  await node(page, 'Run hardening script').click();
  await panel.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Complete and Verified' }).click();
  await expect(panel.getByRole('alert')).toHaveText('Attach evidence before marking this step Complete and Verified');
  await expect(node(page, 'Run hardening script')).toHaveAccessibleName('Run hardening script, Not Started');

  await page.reload();
  await openFlowchart(page);
  await expect(node(page, 'Open README')).toHaveAccessibleName('Open README, In Progress');
  await node(page, 'Open README').click();
  await expect(inspector(page).getByLabel('Notes')).toHaveValue('README pasted from the competition page');
  // Screen-reader list mirrors the statuses.
  await expect(page.getByRole('list', { name: 'Hardening steps' }).getByText('Open README: In Progress')).toBeAttached();
});

test('decision node: actions are disabled with the reason until their conditions hold, and nothing changes', async ({ page }) => {
  await signIn(page, `e2e-${randomUUID()}@example.test`);
  await newSession(page, 'Flow decision');
  await openFlowchart(page);
  await page.getByRole('button', { name: 'Final point check, decision' }).click();
  const panel = inspector(page);
  await expect(panel.getByText('Continue remediation').first()).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Mark complete' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Start another cycle' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Mark complete' }).locator('xpath=..').hover();
  await expect(page.getByRole('tooltip').first()).toContainText('Mark “Check final points” Complete and Verified first');
  await panel.getByRole('button', { name: 'Start another cycle' }).locator('xpath=..').hover();
  await expect(page.getByRole('tooltip').first()).toContainText('Upload a LEADS report for cycle 1 first');
  await expect(panel.getByText('No cycle has been closed or remediated yet.')).toBeVisible();
  await expect(node(page, 'Submit final')).toHaveAccessibleName('Submit final, Not Started');
});

test('nodes are keyboard operable: Enter opens the node panel', async ({ page }) => {
  await signIn(page, `e2e-${randomUUID()}@example.test`);
  await newSession(page, 'Flow keyboard');
  await openFlowchart(page);
  await node(page, 'Open README').focus();
  await page.keyboard.press('Enter');
  await expect(inspector(page).getByRole('heading', { name: 'Step: Open README' })).toBeVisible();
});
