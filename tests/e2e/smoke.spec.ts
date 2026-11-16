import { expect, test } from '@playwright/test';

test('login page renders', async ({ page }) => {
  const response = await page.goto('/login');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Sign in to Armadillo' })).toBeVisible();
});
