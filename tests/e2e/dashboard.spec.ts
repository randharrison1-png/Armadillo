import { expect, test } from '@playwright/test';
import { signIn } from './support/helpers';

test('fresh account shows empty state, no sample activity', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText('No hardening sessions yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Resume' })).toHaveCount(0);
});

test('create-session dialog validates the title inline', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await dialog.getByRole('button', { name: 'Create session' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter a title');
  await expect(page).toHaveURL(/\/app$/);
});

test('session card shows current stage and Resume opens /app/sessions/{id}', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await dialog.getByLabel('Title').fill('CyberPatriot Round 1');
  await dialog.getByRole('combobox', { name: 'Operating system' }).click();
  await page.getByRole('option', { name: 'Linux' }).click();
  await dialog.getByRole('button', { name: 'Create session' }).click();
  await expect(page).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'CyberPatriot Round 1' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Claude' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Flowchart' })).toBeVisible();

  await page.goto('/app');
  const card = page.getByRole('main').getByRole('listitem').filter({ hasText: 'CyberPatriot Round 1' });
  await expect(card).toContainText('Open README');
  await expect(card).toContainText('Linux');
  await card.getByRole('link', { name: 'Resume' }).click();
  await expect(page).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('tab', { name: 'Claude' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Flowchart' })).toBeVisible();

  // Sidebar lists the session, and the list page shows it.
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'CyberPatriot Round 1' })).toBeVisible();
  await page.goto('/app/sessions');
  await expect(page.getByRole('main').getByRole('listitem').filter({ hasText: 'CyberPatriot Round 1' })).toBeVisible();
});

test("another user's session id is a 404", async ({ page, browser }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByRole('dialog').getByLabel('Title').fill('Private');
  await page.getByRole('dialog').getByRole('button', { name: 'Create session' }).click();
  await expect(page).toHaveURL(/\/app\/sessions\//);
  const url = page.url();

  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await signIn(other);
  const res = await other.goto(url);
  expect(res?.status()).toBe(404);
  await ctx.close();
});
