import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const SESSION_COOKIE = 'armadillo_test_session';

test('unauthenticated /app redirects to /login', async ({ page }) => {
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in to Armadillo' })).toBeVisible();
});

test('a forged session cookie does not get past /login', async ({ page, context, baseURL }) => {
  const id = randomUUID();
  const email = Buffer.from('forged@example.test').toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  await context.addCookies([
    { name: SESSION_COOKIE, value: `${id}.${email}.${exp}.${'A'.repeat(43)}`, url: baseURL! },
  ]);
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login$/);
});

test('sign in then land on the app', async ({ page, context }) => {
  const email = `e2e-${randomUUID()}@example.test`;

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText(email)).toBeVisible();

  const cookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
  expect(cookie?.secure).toBe(true); // production build
  expect(cookie?.value).not.toContain(email); // email is encoded, and the value is signed

  // Signed-in users skip the login page.
  await page.goto('/login');
  await expect(page).toHaveURL(/\/app$/);

  // Sign out, confirm the guard is back, then sign in again as the same user.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await context.cookies()).find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('Email').fill(email.toUpperCase());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText(email)).toBeVisible();
});

test('sign in rejects an invalid email', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('not-an-email');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Filter: Next's route announcer is also role=alert.
  await expect(page.getByRole('alert').filter({ hasText: 'Enter a valid email address' })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});
