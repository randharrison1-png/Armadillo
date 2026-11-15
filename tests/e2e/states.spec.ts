import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import postgres from 'postgres';
import { testDatabaseUrl } from '../db/env';

/**
 * Empty, loading and error states of every main page.
 *
 *  - empty: a fresh user sees explanatory text and a primary action (no sample data).
 *  - loading: route-level loading.tsx skeletons appear during client navigation while the test-only
 *    delay is on (cookie read by src/server/testing/faults.ts; honoured only under the test provider).
 *  - error: a forced failure renders the route error boundary with generic copy and a digest, never
 *    the thrown message, and "Try again" recovers once the fault is cleared.
 */

const sql = postgres(testDatabaseUrl(), { max: 2, onnotice: () => {} });
test.afterAll(async () => {
  await sql.end();
});

const FAULT_COOKIE = 'armadillo_test_faults';
const LEAK = 'Forced test failure';

async function setFaults(context: BrowserContext, baseURL: string, faults: { delayMs?: number; fail?: string[] | '*' }) {
  await context.addCookies([{ name: FAULT_COOKIE, value: encodeURIComponent(JSON.stringify(faults)), url: baseURL }]);
}
const clearFaults = (context: BrowserContext) => context.clearCookies({ name: FAULT_COOKIE });

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(`e2e-${randomUUID()}@example.test`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

async function createSession(page: Page, title: string): Promise<string> {
  await page.getByRole('button', { name: 'New session' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Create session' }).click();
  await expect(page).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

/**
 * Resolves once the router has prefetched `pathname` and its prefetching has gone quiet. Next shows
 * a route's loading.tsx during a client navigation from that prefetch; a click that lands while a
 * prefetch wave is still in flight (the router prefetches every visible link twice right after
 * load) navigates without it. Start this before the page that renders the link loads.
 */
function prefetched(page: Page, pathname: string): Promise<void> {
  let lastPrefetch = Date.now();
  page.on('request', (r) => {
    if (r.headers()['next-router-prefetch'] === '1') lastPrefetch = Date.now();
  });
  return (async () => {
    await page.waitForResponse((r) => new URL(r.url()).pathname === pathname && r.request().headers()['next-router-prefetch'] === '1', { timeout: 20_000 });
    while (Date.now() - lastPrefetch < 800) await page.waitForTimeout(100);
  })();
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const slug = () => Array.from(randomBytes(10), (b) => ALPHABET[b % 64]).join('');
async function seedPublicPaste(title: string): Promise<string> {
  const owner = randomUUID();
  await sql`insert into auth.users (id, email) values (${owner}, ${`states-${owner}@example.test`})`;
  const s = slug();
  await sql`insert into paste.pastes (slug, owner_id, title, content, language, visibility) values (${s}, ${owner}, ${title}, 'echo hi', 'bash', 'public')`;
  return s;
}

type AppCase = {
  name: string;
  /** Fault key in src/server/testing/faults.ts. */
  fault: string;
  path: string;
  /** Sidebar link used for client-side navigation (a different page than `path`). */
  link: string;
  loading: string;
  heading: string | RegExp;
  empty: (page: Page) => Promise<void>;
};

const APP_PAGES: AppCase[] = [
  {
    name: 'dashboard',
    fault: 'dashboard',
    path: '/app',
    link: 'Dashboard',
    loading: 'Loading dashboard',
    heading: 'Dashboard',
    empty: async (page) => {
      await expect(page.getByText('No hardening sessions yet')).toBeVisible();
      await expect(page.getByText('Start a session to work through a hardening round step by step.')).toBeVisible();
      await expect(page.getByRole('main').getByRole('button', { name: 'New session' })).toBeVisible();
    },
  },
  {
    name: 'sessions',
    fault: 'sessions',
    path: '/app/sessions',
    link: 'Sessions',
    loading: 'Loading sessions',
    heading: 'Sessions',
    empty: async (page) => {
      await expect(page.getByText('No hardening sessions yet')).toBeVisible();
      await expect(page.getByRole('main').getByRole('button', { name: 'New session' })).toBeVisible();
    },
  },
  {
    name: 'library',
    fault: 'library',
    path: '/app/library',
    link: 'Script Library',
    loading: 'Loading script library',
    heading: 'Script Library',
    empty: async (page) => {
      await expect(page.getByText('No scripts in your library')).toBeVisible();
      await expect(page.getByText(/Upload a script file or write one here/)).toBeVisible();
      await expect(page.getByRole('main').getByRole('button', { name: 'Upload file' })).toBeVisible();
      await expect(page.getByRole('main').getByRole('button', { name: 'Create script' })).toBeVisible();
    },
  },
  {
    name: 'reports',
    fault: 'reports',
    path: '/app/reports',
    link: 'Sessions & Reports',
    loading: 'Loading reports',
    heading: 'Sessions & Reports',
    empty: async (page) => {
      await expect(page.getByText('No sessions yet')).toBeVisible();
      await expect(page.getByText(/Reports, remediation and evidence of each hardening session appear here/)).toBeVisible();
      await expect(page.getByRole('main').getByRole('button', { name: 'New session' })).toBeVisible();
    },
  },
  {
    name: 'pastes',
    fault: 'pastes',
    path: '/app/pastes',
    link: 'My pastes',
    loading: 'Loading pastes',
    heading: 'My pastes',
    empty: async (page) => {
      await expect(page.getByText('You have not published any pastes')).toBeVisible();
      await expect(page.getByText(/Publishing is always an explicit action/)).toBeVisible();
      await expect(page.getByRole('main').getByRole('link', { name: 'New paste' })).toBeVisible();
    },
  },
  {
    name: 'settings',
    fault: 'settings',
    path: '/app/settings',
    link: 'Settings',
    loading: 'Loading settings',
    heading: 'Settings',
    empty: async (page) => {
      await expect(page.getByText(/Without your own key, Claude uses the workspace key|No key is configured yet/)).toBeVisible();
      await expect(page.getByRole('main').getByRole('button', { name: 'Save key' })).toBeVisible();
    },
  },
];

/** Start somewhere else in the app so the link click is a client-side navigation. */
const startFor = (c: AppCase) => (c.path === '/app/sessions' || c.path === '/app' ? '/app/settings' : '/app/sessions');

for (const c of APP_PAGES) {
  test.describe(`${c.name} page states`, () => {
    test('empty: explains itself and offers a primary action', async ({ page }) => {
      await signIn(page);
      await page.goto(c.path);
      await expect(page.getByRole('heading', { level: 1, name: c.heading })).toBeVisible();
      await c.empty(page);
    });

    test('loading: shows a skeleton during client navigation, then the page', async ({ page, context, baseURL }) => {
      await signIn(page);
      const ready = prefetched(page, c.path);
      await page.goto(startFor(c));
      await ready;
      await setFaults(context, baseURL!, { delayMs: 2500 });
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: c.link, exact: true }).click();
      const skeleton = page.getByRole('status', { name: c.loading });
      await expect(skeleton).toBeVisible();
      await expect(skeleton).toHaveAttribute('aria-busy', 'true');
      await expect(page.getByRole('heading', { level: 1, name: c.heading })).toBeVisible({ timeout: 15_000 });
      await expect(skeleton).toBeHidden();
    });

    test('error: generic message, digest, no leak, and Try again recovers once cleared', async ({ page, context, baseURL }) => {
      await signIn(page);
      await setFaults(context, baseURL!, { fail: [c.fault] });
      await page.goto(c.path);

      const alert = page.getByRole('alert').filter({ hasText: 'Something went wrong' });
      await expect(alert).toBeVisible();
      await expect(alert).toContainText(/Reference: \S+/);
      await expect(page.locator('body')).not.toContainText(LEAK);
      // The shell stays: an error in one page does not take the navigation away.
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

      await clearFaults(context);
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByRole('heading', { level: 1, name: c.heading })).toBeVisible();
      await expect(alert).toBeHidden();
    });
  });
}

test.describe('session detail page states', () => {
  test('empty: a fresh session explains what to do and offers the composer', async ({ page }) => {
    await signIn(page);
    await createSession(page, 'Fresh session');
    await expect(page.getByText('Ask Claude about this session')).toBeVisible();
    await expect(page.getByText(/Claude only sees the items you select under Context below/)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message Claude' })).toBeVisible();
  });

  test('loading: skeleton while the session opens from the list', async ({ page, context, baseURL }) => {
    await signIn(page);
    const path = await createSession(page, 'Slow session');
    const ready = prefetched(page, path);
    await page.goto('/app/sessions');
    await ready;
    await setFaults(context, baseURL!, { delayMs: 2500 });
    await page.getByRole('link', { name: /Resume/ }).click();
    const skeleton = page.getByRole('status', { name: 'Loading session' });
    await expect(skeleton).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Slow session' })).toBeVisible({ timeout: 15_000 });
    await expect(skeleton).toBeHidden();
  });

  test('error: generic message, no leak, Try again recovers', async ({ page, context, baseURL }) => {
    await signIn(page);
    const path = await createSession(page, 'Broken session');
    await setFaults(context, baseURL!, { fail: ['session'] });
    await page.goto(path);
    const alert = page.getByRole('alert').filter({ hasText: 'Something went wrong' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Reference: \S+/);
    await expect(page.locator('body')).not.toContainText(LEAK);
    await clearFaults(context);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'Broken session' })).toBeVisible();
    await expect(alert).toBeHidden();
  });
});

test.describe('public paste page states', () => {
  test('empty: an unknown or expired paste explains itself and links back', async ({ page }) => {
    const res = await page.goto(`/p/${slug()}`);
    expect(res?.status()).toBe(404);
    await expect(page.getByText("This paste has expired or doesn't exist")).toBeVisible();
    await expect(page.getByRole('link', { name: 'Browse public pastes' })).toBeVisible();
  });

  test('loading: skeleton while a paste opens from the list', async ({ page, context, baseURL }) => {
    const title = `states ${randomBytes(4).toString('hex')}`;
    const s = await seedPublicPaste(title);
    const ready = prefetched(page, `/p/${s}`);
    await page.goto(`/p?q=${encodeURIComponent(title)}`);
    const link = page.getByRole('link', { name: new RegExp(title) });
    await expect(link).toBeVisible();
    await ready;
    await setFaults(context, baseURL!, { delayMs: 2500 });
    await link.click();
    const skeleton = page.getByRole('status', { name: 'Loading paste' });
    await expect(skeleton).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: 15_000 });
    await expect(skeleton).toBeHidden();
  });

  test('error: generic message, no leak, Try again recovers', async ({ page, context, baseURL }) => {
    const title = `states ${randomBytes(4).toString('hex')}`;
    const s = await seedPublicPaste(title);
    await setFaults(context, baseURL!, { fail: ['paste'] });
    await page.goto(`/p/${s}`);
    const alert = page.getByRole('alert').filter({ hasText: 'Something went wrong' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Reference: \S+/);
    await expect(page.locator('body')).not.toContainText(LEAK);
    await clearFaults(context);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(alert).toBeHidden();
  });
});

test.describe('shared behaviour', () => {
  test('a forced failure during client navigation lands on the error boundary too', async ({ page, context, baseURL }) => {
    await signIn(page);
    await page.goto('/app/settings');
    await setFaults(context, baseURL!, { fail: ['library'] });
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Script Library', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Something went wrong' });
    await expect(alert).toBeVisible();
    await expect(page.locator('body')).not.toContainText(LEAK);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    // Other pages still work while one is failing.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  });

  test('the fault cookie has no effect without a valid session or on a page it does not name', async ({ page, context, baseURL }) => {
    await signIn(page);
    await setFaults(context, baseURL!, { fail: ['library'] });
    await page.goto('/app/reports');
    await expect(page.getByRole('heading', { level: 1, name: 'Sessions & Reports' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Something went wrong' })).toHaveCount(0);
  });

  test('an unknown URL shows a not-found page with a way back', async ({ page }) => {
    const res = await page.goto('/definitely-not-a-page');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to the workspace' })).toHaveAttribute('href', '/app');
  });
});
