import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { testDatabaseUrl } from '../db/env';

const sql = postgres(testDatabaseUrl(), { max: 2, onnotice: () => {} });
test.afterAll(async () => {
  await sql.end();
});

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const slug = () => Array.from(randomBytes(10), (b) => ALPHABET[b % 64]).join('');

async function seedPaste(): Promise<string> {
  const owner = randomUUID();
  await sql`insert into auth.users (id, email) values (${owner}, ${`headers-${owner}@example.test`})`;
  const s = slug();
  await sql`insert into paste.pastes (slug, owner_id, title, content, language, visibility) values (${s}, ${owner}, 'Headers', 'echo hi', 'bash', 'public')`;
  return s;
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(`e2e-${randomUUID()}@example.test`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

/** Records every CSP violation (securitypolicyviolation events and Chrome's console errors). */
async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'} (${e.sourceFile ?? ''}:${e.lineNumber})`);
    });
  });
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /content security policy|refused to (load|execute|apply|create|connect)/i.test(m.text())) consoleErrors.push(m.text());
  });
  return async () => {
    const events = await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []).catch(() => []);
    return [...events, ...consoleErrors];
  };
}

const CORE = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'x-frame-options': 'DENY',
};

function expectCoreHeaders(headers: Record<string, string>) {
  for (const [k, v] of Object.entries(CORE)) expect(headers[k], k).toBe(v);
  expect(headers['strict-transport-security']).toMatch(/^max-age=63072000(; includeSubDomains)?$/);
}

const directive = (csp: string, name: string) =>
  csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `) || d === name);

test.describe('security headers', () => {
  test('app page: static headers plus a nonce CSP that forbids framing and inline script', async ({ page }) => {
    await signIn(page);
    const res = await page.request.get('/app');
    expect(res.status()).toBe(200);
    const h = res.headers();
    expectCoreHeaders(h);
    const csp = h['content-security-policy']!;
    expect(csp).toBeTruthy();
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'script-src')).toMatch(/^script-src 'self' 'nonce-[^']+' 'strict-dynamic'$/);
    expect(directive(csp, 'worker-src')).toBe("worker-src 'self' blob:");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'connect-src')).toMatch(/^connect-src 'self'/);

    // Every inline script Next emits carries this request's nonce.
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    const html = await res.text();
    const inline = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]!).filter((attrs) => !/\bsrc=/.test(attrs));
    expect(inline.length).toBeGreaterThan(0);
    for (const attrs of inline) expect(attrs).toContain(`nonce="${nonce}"`);
  });

  test('a new nonce on every request', async ({ page }) => {
    await signIn(page);
    const a = (await page.request.get('/app')).headers()['content-security-policy'];
    const b = (await page.request.get('/app')).headers()['content-security-policy'];
    expect(a).not.toBe(b);
  });

  test('paste page: same headers, and the signed-out public page carries them too', async ({ request }) => {
    const s = await seedPaste();
    const res = await request.get(`/p/${s}`);
    expect(res.status()).toBe(200);
    const h = res.headers();
    expectCoreHeaders(h);
    expect(directive(h['content-security-policy']!, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(h['content-security-policy']).toMatch(/'nonce-[^']+'/);
    const login = await request.get('/login');
    expectCoreHeaders(login.headers());
    expect(login.headers()['content-security-policy']).toMatch(/'nonce-[^']+'/);
  });

  test('raw paste route: core headers and its own strict sandbox CSP (nothing may load or run)', async ({ request }) => {
    const s = await seedPaste();
    const res = await request.get(`/p/${s}/raw`);
    expect(res.status()).toBe(200);
    const h = res.headers();
    expectCoreHeaders(h);
    expect(h['content-type']).toContain('text/plain');
    expect(h['content-security-policy']).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
    expect(await res.text()).toBe('echo hi');
  });

  test('the 404 page is rendered dynamically, so its scripts carry the nonce', async ({ request }) => {
    const res = await request.get('/definitely-not-a-page');
    expect(res.status()).toBe(404);
    const csp = res.headers()['content-security-policy']!;
    expect(csp).toBeTruthy();
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    const html = await res.text();
    const inline = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]!).filter((attrs) => !/\bsrc=/.test(attrs));
    for (const attrs of inline) expect(attrs).toContain(`nonce="${nonce}"`);
  });
});

test.describe('CSP does not break the app', () => {
  test('main pages load and hydrate with no CSP violations', async ({ page }) => {
    const violations = await watchCsp(page);
    await signIn(page);
    const s = await seedPaste();
    for (const path of ['/app', '/app/sessions', '/app/library', '/app/reports', '/app/pastes', '/app/settings', '/p', `/p/${s}`, '/definitely-not-a-page']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
    }
    // Hydration worked: client interactions run (sidebar collapse toggles state in a client component).
    await page.goto('/app');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'true');
    expect(await violations()).toEqual([]);
  });

  test('Monaco loads locally with its worker, with no CSP violations', async ({ page }) => {
    const violations = await watchCsp(page);
    await signIn(page);
    await page.goto('/app/library');
    await page.getByRole('button', { name: 'Create script' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Create script' });
    await dialog.getByLabel('Filename').fill('csp.sh');
    await dialog.getByLabel('Name', { exact: true }).fill('CSP check');
    await dialog.getByLabel('Content').fill('echo one');
    await dialog.getByRole('button', { name: 'Create script' }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('row').filter({ hasText: 'CSP check' }).getByRole('link', { name: 'Open' }).click();
    await expect(page).toHaveURL(/\/app\/library\/[0-9a-f-]{36}$/);
    const editor = page.getByRole('region', { name: 'Script content' }).locator('.monaco-editor').first();
    await expect(editor).toBeVisible();

    // Typing exercises the editor; its web worker (blob/self origin) must be allowed to start.
    await editor.locator('.view-lines').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('echo two https://example.test/a');
    await expect(editor.locator('.view-lines')).toContainText('echo two');
    await expect.poll(() => page.workers().length, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    expect(await violations()).toEqual([]);
  });
});
