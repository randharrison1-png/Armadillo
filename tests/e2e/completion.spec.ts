import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { testDatabaseUrl } from '../db/env';
import { forensicPanel, inspector, newSession, node, openFlowchart, panel, showInspector, signIn } from './support/helpers';

const sql = postgres(testDatabaseUrl(), { max: 2, onnotice: () => {} });
test.afterAll(async () => {
  await sql.end();
});

/** A session script with v1 and v2, a README, and requirements bound to v2 (two plain, one disruptive and unreviewed). */
async function seedScript(email: string, sessionId: string) {
  const [{ id: owner }] = await sql<{ id: string }[]>`select id from auth.users where email = ${email}`;
  const [script] = await sql<{ id: string }[]>`
    insert into public.scripts (owner_id, session_id, name, filename, category, function, os_compat)
    values (${owner}, ${sessionId}, 'Guest hardening', 'guest.ps1', 'windows', 'session_generated', '{windows}') returning id`;
  const v = async (n: number) =>
    (await sql<{ id: string }[]>`
      insert into public.script_versions (owner_id, script_id, version_no, content, encoding, line_ending, language, sha256, author)
      values (${owner}, ${script!.id}, ${n}, ${`Write-Host v${n}`}, 'utf-8', 'lf', 'powershell', ${String(n).repeat(64)}, 'user') returning id`)[0]!.id;
  const v1 = await v(1);
  const v2 = await v(2);
  await sql`update public.scripts set current_version_id = ${v2} where id = ${script!.id}`;
  const [readme] = await sql<{ id: string }[]>`insert into public.readmes (owner_id, session_id, source, text) values (${owner}, ${sessionId}, 'paste', 'x') returning id`;
  const req = (text: string, o: { disruptive?: boolean; version?: string } = {}) =>
    sql`insert into public.requirements (owner_id, session_id, readme_id, text, segment_id, coverage, disruptive, script_version_id, created_at)
        values (${owner}, ${sessionId}, ${readme!.id}, ${text}, 'p-0-x', 'covered', ${o.disruptive ?? false}, ${o.version ?? v2}, now())`;
  await req('Disable the guest account');
  await req('Disable the print spooler');
  await req('Disable remote desktop', { disruptive: true });
  await req('Bound to v1 only', { version: v1 });
  return { owner, v1, v2, scriptId: script!.id };
}

const matrixRow = (page: Page, text: string) => panel(page).getByRole('table', { name: 'Requirements' }).getByRole('row').filter({ hasText: text });

test('uploading execution output for v2 moves its covered requirements to Reported, not Verified', async ({ page }) => {
  const email = `e2e-${randomUUID()}@example.test`;
  await signIn(page, email);
  const sessionId = await newSession(page, 'Evidence run');
  await seedScript(email, sessionId);
  await page.reload();

  await openFlowchart(page);
  await node(page, 'Run hardening script').click();
  await showInspector(page);
  const evidence = inspector(page).getByRole('region', { name: 'Evidence' });
  await expect(evidence.getByText('No evidence yet')).toBeVisible();
  await expect(evidence.getByLabel('Evidence type')).toHaveValue('execution_output');
  await evidence.getByLabel('Script version you ran').selectOption({ label: 'Guest hardening · v2' });
  await evidence.getByLabel('Evidence file').setInputFiles({ name: 'run-output.txt', mimeType: 'text/plain', buffer: Buffer.from('Guest account disabled\n') });
  await evidence.getByLabel('Evidence note').fill('Ran as Administrator');
  await evidence.getByRole('button', { name: 'Add evidence' }).click();

  await expect(page.getByText('2 requirements marked Reported; 1 potentially disruptive requirement needs review first')).toBeVisible();
  const item = evidence.getByTestId('evidence-item');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('Output of Guest hardening · v2');
  await expect(item).toContainText('Cycle 1');
  const [download] = await Promise.all([page.waitForEvent('download'), item.getByRole('link', { name: 'Download run-output.txt' }).click()]);
  expect(download.suggestedFilename()).toBe('run-output.txt');
  expect(readFileSync(await download.path(), 'utf8')).toBe('Guest account disabled\n');

  // Requirements: Reported (never Verified); the disruptive one waits for review; the v1 one is untouched.
  await page.goto(`/app/sessions/${sessionId}?tab=requirements`);
  await expect(page.getByRole('tab', { name: 'Requirements' })).toHaveAttribute('aria-selected', 'true');
  await expect(matrixRow(page, 'Disable the guest account').getByText('Reported', { exact: true })).toBeVisible();
  await expect(matrixRow(page, 'Disable the print spooler').getByText('Reported', { exact: true })).toBeVisible();
  await expect(matrixRow(page, 'Disable remote desktop').getByText('Proposed', { exact: true })).toBeVisible();
  await expect(matrixRow(page, 'Bound to v1 only').getByText('Proposed', { exact: true })).toBeVisible();
  await expect(panel(page).getByRole('table', { name: 'Requirements' }).getByText('Verified', { exact: true })).toHaveCount(0);
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.requirements where session_id = ${sessionId} and work_state = 'verified'`;
  expect(n).toBe(0);
});

test('final points are recorded per cycle and shown as Reported points', async ({ page }) => {
  await signIn(page, `e2e-${randomUUID()}@example.test`);
  await newSession(page, 'Points');
  await openFlowchart(page);
  await node(page, 'Check final points').click();
  await showInspector(page);
  const points = inspector(page).getByRole('region', { name: 'Final points' });
  await expect(points.getByTestId('reported-points')).toHaveText('Not recorded');
  await points.getByLabel('Points', { exact: true }).fill('1.005');
  await points.getByRole('button', { name: 'Record points' }).click();
  await expect(points.getByRole('alert')).toContainText('at most 2 decimals');
  await points.getByLabel('Points', { exact: true }).fill('84.5');
  await points.getByLabel('Target (optional)').fill('100');
  await points.getByRole('button', { name: 'Record points' }).click();
  await expect(points.getByTestId('reported-points')).toHaveText('84.5');
  await expect(points.getByTestId('target-points')).toHaveText('100');
  // Recording points changes no step.
  await expect(node(page, 'Check final points')).toHaveAccessibleName('Check final points, Not Started');
});

test('submit is blocked while forensic questions are open unless an override note is given', async ({ page }) => {
  await signIn(page, `e2e-${randomUUID()}@example.test`);
  const sessionId = await newSession(page, 'Forensics');
  await openFlowchart(page);
  await node(page, 'Forensic questions').click();
  await showInspector(page);
  const forensic = forensicPanel(page);
  await expect(forensic.getByTestId('forensic-count')).toHaveText('No questions yet');
  const added = ['Who created the hidden admin account?', 'Which service listens on port 4444?'];
  for (const [i, q] of added.entries()) {
    await forensic.getByLabel('New question').fill(q);
    await forensic.getByRole('button', { name: 'Add question' }).click();
    // Wait on the list item and the count, not getByText (the textarea's own value would match).
    await expect(forensic.getByRole('listitem').filter({ hasText: q })).toBeVisible();
    await expect(forensic.getByTestId('forensic-count')).toHaveText(`0 of ${i + 1} answered`);
    await expect(forensic.getByLabel('New question')).toHaveValue('');
  }
  await expect(forensic.getByTestId('forensic-count')).toHaveText('0 of 2 answered');
  await forensic.getByRole('button', { name: 'Answer question 1' }).click();
  await forensic.getByLabel('Answer to question 1').fill('The user svc_backup');
  await forensic.getByRole('button', { name: 'Save answer' }).click();
  await expect(forensic.getByTestId('forensic-count')).toHaveText('1 of 2 answered');
  // Edit and reopen.
  await forensic.getByRole('button', { name: 'Edit answer to question 1' }).click();
  await forensic.getByLabel('Answer to question 1').fill('The user svc_backup2');
  await forensic.getByRole('button', { name: 'Save answer' }).click();
  // The answer textarea mirrors its value as text: wait for it to close before matching the text.
  await expect(forensic.getByLabel('Answer to question 1', { exact: true })).toBeHidden();
  await expect(forensic.getByText('The user svc_backup2')).toBeVisible();
  await forensic.getByRole('button', { name: 'Reopen question 1' }).click();
  await expect(forensic.getByTestId('forensic-count')).toHaveText('0 of 2 answered');
  await forensic.getByRole('button', { name: 'Answer question 1' }).click();
  await forensic.getByRole('button', { name: 'Save answer' }).click();
  await expect(forensic.getByTestId('forensic-count')).toHaveText('1 of 2 answered');
  // The step status stays the user's to set.
  await expect(node(page, 'Forensic questions')).toHaveAccessibleName('Forensic questions, Not Started');

  // Submit final: verification evidence first.
  await node(page, 'Submit final').click();
  const submit = inspector(page).getByRole('region', { name: 'Final submission' });
  await expect(submit.getByTestId('submit-forensic-count')).toHaveText('1 of 2 answered');
  await expect(submit.getByRole('button', { name: 'Submit final' })).toBeDisabled();
  const evidence = inspector(page).getByRole('region', { name: 'Evidence' });
  await evidence.getByLabel('Evidence type').selectOption('screenshot');
  await evidence.getByLabel('Evidence file').setInputFiles({ name: 'scoreboard.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  await evidence.getByRole('button', { name: 'Add evidence' }).click();
  await expect(evidence.getByRole('link', { name: 'Download scoreboard.png' })).toBeVisible();

  // Blocked without a reason; a short reason keeps it disabled; a real one enables it.
  await submit.getByLabel('Reason to submit with open questions').fill('too short');
  await expect(submit.getByRole('button', { name: 'Submit final' })).toBeDisabled();
  await submit.getByLabel('Reason to submit with open questions').fill('The second question is out of scope for this image');
  await submit.getByRole('button', { name: 'Submit final' }).click();
  const dialog = page.getByRole('dialog', { name: 'Submit this session?' });
  await expect(dialog).toContainText('Submitting freezes this session');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  const [{ status: before }] = await sql<{ status: string }[]>`select status from public.sessions where id = ${sessionId}`;
  expect(before).toBe('active');
  await submit.getByRole('button', { name: 'Submit final' }).click();
  await dialog.getByRole('button', { name: 'Submit and freeze session' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('completed-banner')).toContainText('Completed');
  const [{ status, notes }] = await sql<{ status: string; notes: string }[]>`
    select s.status, w.notes from public.sessions s join public.workflow_steps w on w.session_id = s.id and w.step = 'submit_final' where s.id = ${sessionId}`;
  expect(status).toBe('completed');
  expect(notes).toBe('Submitted with open forensic questions: The second question is out of scope for this image');
});

test('submit without verification evidence is refused with a clear message', async ({ page }) => {
  await signIn(page, `e2e-${randomUUID()}@example.test`);
  await newSession(page, 'No evidence');
  await openFlowchart(page);
  await node(page, 'Submit final').click();
  await showInspector(page);
  const submit = inspector(page).getByRole('region', { name: 'Final submission' });
  await submit.getByRole('button', { name: 'Submit final' }).click();
  const dialog = page.getByRole('dialog', { name: 'Submit this session?' });
  await dialog.getByRole('button', { name: 'Submit and freeze session' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Attach verification evidence to Submit final');
  await expect(page.getByTestId('completed-banner')).toHaveCount(0);
});

test('completed session is read-only but fully viewable', async ({ page }) => {
  const email = `e2e-${randomUUID()}@example.test`;
  await signIn(page, email);
  const sessionId = await newSession(page, 'Frozen session');
  const { owner, scriptId } = await seedScript(email, sessionId);
  await sql`insert into public.leads_reports (owner_id, session_id, cycle_no, filename, raw_text) values (${owner}, ${sessionId}, 1, 'leads.txt', 'Score: 80/100 points')`;
  await sql`insert into public.remediation_cycles (owner_id, session_id, cycle_no, points) values (${owner}, ${sessionId}, 1, 80)`;
  await page.reload();

  // Verification evidence, then submit through the UI.
  await openFlowchart(page);
  await node(page, 'Submit final').click();
  await showInspector(page);
  const evidence = inspector(page).getByRole('region', { name: 'Evidence' });
  await evidence.getByLabel('Evidence note').fill('Scoreboard shows 80 points');
  await evidence.getByRole('button', { name: 'Add evidence' }).click();
  await expect(evidence.getByTestId('evidence-item')).toHaveCount(1);
  await inspector(page).getByRole('region', { name: 'Final submission' }).getByRole('button', { name: 'Submit final' }).click();
  await page.getByRole('dialog', { name: 'Submit this session?' }).getByRole('button', { name: 'Submit and freeze session' }).click();
  await expect(page.getByTestId('completed-banner')).toContainText('Completed');
  await page.reload();
  await expect(page.getByTestId('completed-banner')).toContainText('This session is read-only');

  // Flowchart: statuses cannot change, evidence cannot be added, but evidence is listed.
  await openFlowchart(page);
  await expect(page.getByTestId('completed-note')).toContainText('Completed');
  await node(page, 'Submit final').click();
  await showInspector(page);
  await expect(node(page, 'Submit final')).toHaveAccessibleName('Submit final, Complete and Verified');
  await expect(inspector(page).getByRole('combobox', { name: 'Status' })).toBeDisabled();
  await expect(inspector(page).getByLabel('Notes')).not.toBeEditable();
  await expect(inspector(page).getByRole('button', { name: 'Add evidence' })).toHaveCount(0);
  await expect(inspector(page).getByTestId('evidence-item')).toHaveCount(1);
  await expect(inspector(page).getByRole('region', { name: 'Final submission' })).toContainText('The session is completed and read-only');
  await node(page, 'Check final points').click();
  await expect(inspector(page).getByTestId('reported-points')).toHaveText('80');
  await expect(inspector(page).getByRole('button', { name: 'Record points' })).toHaveCount(0);
  await node(page, 'Forensic questions').click();
  await expect(inspector(page).getByRole('button', { name: 'Add question' })).toHaveCount(0);

  // Everything still opens: README, requirements, reports, the script.
  await expect(inspector(page).getByText('This session is completed; READMEs can no longer be added.')).toBeVisible();
  await page.goto(`/app/sessions/${sessionId}?tab=requirements`);
  await expect(page.getByRole('tab', { name: 'Requirements' })).toHaveAttribute('aria-selected', 'true');
  await expect(matrixRow(page, 'Disable the guest account')).toBeVisible();
  await page.goto(`/app/sessions/${sessionId}?tab=reports`);
  await expect(panel(page).getByText('leads.txt').first()).toBeVisible();
  await page.goto(`/app/sessions/${sessionId}?tab=script&id=${scriptId}&name=guest.ps1`);
  await expect(page.getByRole('tab', { name: 'guest.ps1' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).getByText('Write-Host v2').first()).toBeVisible();
  await page.goto(`/app/sessions/${sessionId}?tab=readme`);
  await expect(page.getByRole('tab', { name: 'README' })).toHaveAttribute('aria-selected', 'true');
  // Writes are refused at the database too.
  await expect(sql`insert into public.evidence (owner_id, session_id, step, kind) values (${owner}, ${sessionId}, 'run_hardening', 'other')`).rejects.toThrow(/read-only/);
});

test('Sessions & Reports: empty state, then sessions with cycles, reports, evidence and links that open the right tab', async ({ page }) => {
  const email = `e2e-${randomUUID()}@example.test`;
  await signIn(page, email);
  await page.goto('/app/reports');
  await expect(page.getByRole('heading', { name: 'No sessions yet' })).toBeVisible();

  const sessionId = await newSession(page, 'Round one');
  const { owner } = await seedScript(email, sessionId);
  const [report] = await sql<{ id: string }[]>`
    insert into public.leads_reports (owner_id, session_id, cycle_no, filename, raw_text, score, created_at)
    values (${owner}, ${sessionId}, 1, 'first-leads.txt', 'x', 50, now() - interval '3 hours') returning id`;
  await sql`insert into public.evidence (owner_id, session_id, step, kind, note, created_at) values (${owner}, ${sessionId}, 'run_hardening', 'execution_output', 'Ran v2 as admin', now() - interval '2 hours')`;
  await sql`insert into public.remediation_cycles (owner_id, session_id, cycle_no, report_id, outcome, points, target_points) values (${owner}, ${sessionId}, 1, ${report!.id}, 'continued', 50, 100)`;
  await sql`update public.sessions set current_cycle = 2 where id = ${sessionId}`;
  await sql`insert into public.leads_reports (owner_id, session_id, cycle_no, filename, raw_text, score) values (${owner}, ${sessionId}, 2, 'second-leads.txt', 'y', 90)`;
  await newSession(page, 'Round two');

  await page.goto('/app/reports');
  const list = page.getByRole('list', { name: 'Sessions' });
  const rows = list.getByRole('listitem').filter({ has: page.locator('summary') });
  // Newest first.
  await expect(rows.first()).toContainText('Round two');
  await expect(rows.nth(1)).toContainText('Round one');
  await expect(rows.nth(1)).toContainText('Active · Windows · Cycle 2');
  await rows.nth(1).locator('summary').click();
  const c1 = rows.nth(1).getByRole('region', { name: 'Cycle 1' });
  await expect(c1).toContainText('Continued to the next cycle');
  await expect(c1).toContainText('Reported points: 50 of 100');
  const timeline = c1.getByRole('list', { name: 'Cycle 1 timeline' }).getByRole('listitem');
  await expect(timeline).toHaveCount(2);
  await expect(timeline.first()).toContainText('LEADS report · first-leads.txt'); // oldest first
  await expect(timeline.nth(1)).toContainText('Evidence (Run hardening script) · Execution output');
  const c2 = rows.nth(1).getByRole('region', { name: 'Cycle 2' });
  await expect(c2).toContainText('Reported points: not recorded');
  await expect(c2).toContainText('second-leads.txt');

  // A report link opens the session on that report's tab.
  await c1.getByRole('link', { name: 'first-leads.txt' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/sessions/${sessionId}\\?tab=report`));
  await expect(page.getByRole('tab', { name: 'Report · first-leads.txt' })).toHaveAttribute('aria-selected', 'true');
});
