import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('upload route requires auth, validates, and stores under the user prefix', async ({ page, request }) => {
  const form = () => ({ kind: 'script', file: { name: 'a.sh', mimeType: 'text/x-sh', buffer: Buffer.from('echo hi\n') } });
  // Anonymous: no cookie.
  expect((await request.post('/api/files/upload', { multipart: form() })).status()).toBe(401);

  await page.goto('/login');
  await page.getByLabel('Email').fill(`e2e-${randomUUID()}@example.test`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // The session cookie is Secure; Chromium sends it to 127.0.0.1 but the APIRequestContext jar does not,
  // so post from the page like the real client does.
  const post = (extra: { name?: string; sessionId?: string }) =>
    page.evaluate(
      async ({ name, sessionId }) => {
        const fd = new FormData();
        fd.append('kind', 'script');
        if (sessionId) fd.append('sessionId', sessionId);
        fd.append('file', new File([name === 'a.sh' ? 'echo hi\n' : 'MZ'], name!, { type: 'application/octet-stream' }));
        const r = await fetch('/api/files/upload', { method: 'POST', body: fd });
        return { status: r.status, body: await r.json() };
      },
      { name: extra.name ?? 'a.sh', sessionId: extra.sessionId },
    );

  const ok = await post({});
  expect(ok.status).toBe(200);
  expect(ok.body.storagePath).toMatch(/^[0-9a-f-]{36}\/library\/[0-9a-f-]{36}-a\.sh$/);
  expect((await post({ name: 'evil.exe' })).status).toBe(415);
  expect((await post({ sessionId: '../x' })).status).toBe(400);
});
