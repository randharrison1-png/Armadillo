import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(`e2e-${randomUUID()}@example.test`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

test('sidebar collapses to icon rail and keeps aria-current on active item', async ({ page }) => {
  await signIn(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeVisible();

  const box = async () => (await page.getByTestId('sidebar').boundingBox())!;
  expect((await box()).width).toBe(240);
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Script Library' })).not.toHaveAttribute('aria-current');
  await expect(nav.getByText('Linux (0)')).toBeVisible();
  await expect(nav.getByRole('button', { name: /Hardening Flowchart/ })).toBeDisabled();

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect.poll(async () => (await box()).width).toBe(56);
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByText('Linux (0)')).toBeHidden();

  // persists across reload
  await page.reload();
  await expect.poll(async () => (await box()).width).toBe(56);

  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect.poll(async () => (await box()).width).toBe(240);

  // keyboard focus reaches nav links
  await nav.getByRole('link', { name: 'Public Pastebin' }).focus();
  await expect(nav.getByRole('link', { name: 'Public Pastebin' })).toBeFocused();
});

test('inspector toggles', async ({ page }) => {
  await signIn(page);
  const toggle = page.getByRole('button', { name: 'Show inspector' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  await page.getByRole('button', { name: 'Hide inspector' }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeHidden();
});
