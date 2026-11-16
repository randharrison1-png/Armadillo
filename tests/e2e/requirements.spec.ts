import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createLibraryScript, mock, newSession, panel, pasteReadme, paragraphIds, signIn } from './support/helpers';

const matrix = (page: Page) => panel(page).getByRole('table', { name: 'Requirements' });
const rowFor = (page: Page, text: string) => matrix(page).getByRole('row').filter({ hasText: text });

test('extract → matrix rows → Source opens the README segment → assess → coverage updates', async ({ page }) => {
  await signIn(page);
  await createLibraryScript(page, 'Guest hardening', 'Disable-LocalUser -Name Guest');
  await newSession(page, 'Requirements round');

  const token = `token-${randomUUID()}`;
  const readme = [
    `Authorized administrators: alice, bob (${token}).`,
    'The guest account must be disabled.',
    'Remote Desktop must stay enabled for the scoring engine.',
  ].join('\n\n');
  const seg = paragraphIds(readme);
  await pasteReadme(page, readme);

  // The README tab offers the matrix.
  await panel(page).getByRole('button', { name: 'Requirements' }).click();
  await expect(page.getByRole('tab', { name: 'Requirements' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).getByText('No requirements yet — extract them from the README')).toBeVisible();

  await mock.enqueue({
    match: token,
    toolUse: {
      input: {
        requirements: [
          { text: 'Disable the guest account', segment_id: seg[1], category: 'accounts', automatable: true, disruptive: false },
          { text: 'Remove unauthorized administrators', segment_id: seg[0], category: 'accounts', automatable: true, disruptive: false },
          { text: 'Keep Remote Desktop enabled', segment_id: seg[2], category: 'remote_access', automatable: true, disruptive: true },
          { text: 'Made-up requirement', segment_id: 'p-42-00000000', category: 'other', automatable: true, disruptive: false },
          { text: 'Uncited requirement', segment_id: '', category: 'other', automatable: true, disruptive: false },
        ],
      },
    },
  });
  await panel(page).getByRole('button', { name: 'Extract requirements' }).first().click();

  await expect(rowFor(page, 'Disable the guest account')).toBeVisible();
  await expect(matrix(page).getByRole('row')).toHaveCount(4); // header + 3
  await expect(panel(page).getByText("2 items were dropped because they didn't cite a README section")).toBeVisible();
  await expect(rowFor(page, 'Disable the guest account').getByText('Detected')).toBeVisible();
  await expect(rowFor(page, 'Disable the guest account').getByText('Proposed')).toBeVisible();
  await expect(rowFor(page, 'Keep Remote Desktop enabled').getByTestId('disruptive-marker')).toHaveText(/Needs review/);
  await expect(panel(page).getByTestId('requirements-summary')).toContainText('3 requirements');

  // Source opens the README at that paragraph and highlights it.
  await rowFor(page, 'Disable the guest account').getByRole('button', { name: /¶ 2/ }).click();
  await expect(panel(page).locator(`#seg-${seg[1]}`)).toHaveAttribute('data-highlight', 'true');
  await expect(panel(page).locator(`#seg-${seg[1]}`)).toHaveText('The guest account must be disabled.');

  // Assess against the library script.
  await page.getByRole('tab', { name: 'Requirements' }).click();
  await mock.enqueue({
    match: 'record_coverage',
    toolUse: {
      input: {
        assessments: [
          { requirement_id: 'R1', coverage: 'covered', disruptive: false, automatable: true },
          { requirement_id: 'R2', coverage: 'missing', suggestion: 'Remove-LocalGroupMember -Group Administrators -Member eve', disruptive: false, automatable: true },
          { requirement_id: 'R3', coverage: 'covered', disruptive: true, automatable: true },
        ],
      },
    },
  });
  await panel(page).getByRole('button', { name: 'Assess coverage' }).click();
  const dialog = page.getByRole('dialog', { name: 'Assess coverage' });
  await dialog.getByLabel('Script version').selectOption({ label: 'Guest hardening · v1' });
  await dialog.getByRole('button', { name: 'Assess coverage' }).click();
  await expect(dialog).toBeHidden();

  await expect(rowFor(page, 'Disable the guest account').getByText('Covered', { exact: true })).toBeVisible();
  await expect(rowFor(page, 'Remove unauthorized administrators').getByText('Missing', { exact: true })).toBeVisible();
  await expect(rowFor(page, 'Remove unauthorized administrators').getByText(/Remove-LocalGroupMember/)).toBeVisible();
  // Disruptive is a separate flag: the row is Covered and still marked "Needs review" until reviewed.
  const rdp = rowFor(page, 'Keep Remote Desktop enabled');
  await expect(rdp.getByText('Covered', { exact: true })).toBeVisible();
  await expect(rdp.getByTestId('disruptive-marker')).toHaveText(/Needs review/);
  await rdp.getByRole('button', { name: 'Mark reviewed: Keep Remote Desktop enabled' }).click();
  await expect(rdp.getByText('Disruptive · reviewed')).toBeVisible();
  await expect(rdp.getByTestId('disruptive-marker')).toHaveCount(0);
  // Claude's assessment is never verification: every row is still Proposed.
  await expect(matrix(page).getByText('Proposed')).toHaveCount(3);
  await expect(matrix(page).getByText('Verified')).toHaveCount(0);

  // Filters.
  await panel(page).getByLabel('Coverage', { exact: true }).selectOption('missing');
  await expect(matrix(page).getByRole('row')).toHaveCount(2);
  await panel(page).getByLabel('Coverage', { exact: true }).selectOption('all');

  // Persisted: reload keeps the matrix (the tab is restored).
  await page.reload();
  await expect(rowFor(page, 'Disable the guest account').getByText('Covered', { exact: true })).toBeVisible();

  // Re-extracting asks first.
  await panel(page).getByRole('button', { name: 'Extract requirements' }).click();
  const confirm = page.getByRole('dialog', { name: 'Extract requirements' });
  await expect(confirm.getByText(/replaces this README's proposed requirements that have no notes/)).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
});
