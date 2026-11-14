import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { AnthropicMockClient, E2E_ANTHROPIC_MOCK_PORT } from '../support/anthropic-mock';

const mock = new AnthropicMockClient(`http://127.0.0.1:${E2E_ANTHROPIC_MOCK_PORT}`);

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(`e2e-${randomUUID()}@example.test`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

async function newSession(page: Page, title: string) {
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Create session' }).click();
  await expect(page).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
}

async function pasteReadme(page: Page, text: string) {
  const show = page.getByRole('button', { name: 'Show inspector' });
  if (await show.isVisible()) await show.click();
  await page.getByRole('complementary', { name: 'Inspector' }).getByRole('button', { name: 'Add README' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add README' });
  await dialog.getByRole('tab', { name: 'Paste' }).click();
  await dialog.getByLabel('README text').fill(text);
  await dialog.getByRole('button', { name: 'Add README' }).click();
  await expect(dialog).toBeHidden();
}

const panel = (page: Page) => page.getByRole('tabpanel');
const conversation = (page: Page) => panel(page).getByRole('list', { name: 'Conversation' });

async function openClaude(page: Page) {
  await page.getByRole('tab', { name: 'Claude' }).click();
  await expect(panel(page).getByRole('textbox', { name: 'Message Claude' })).toBeVisible();
}

test('sends a message with selected context and sees the streamed reply', async ({ page }) => {
  await signIn(page);
  await newSession(page, 'Claude chat');
  await expect(panel(page).getByText('Ask Claude about this session')).toBeVisible();
  await expect(panel(page).getByText(/Claude only sees the items you select/)).toBeVisible();

  await pasteReadme(page, 'Authorized administrators: alice. Keep the FTP service running.');
  await openClaude(page);

  // Nothing is selected until the user selects it.
  const picker = panel(page).getByRole('region', { name: 'Context for Claude' });
  await expect(picker.getByText('nothing selected')).toBeVisible();
  await picker.getByRole('button', { name: /Context/ }).click();
  await expect(picker.getByText('Claude only sees the items you select.', { exact: false })).toBeVisible();
  await expect(picker.getByText('No session scripts yet')).toBeVisible();
  await picker.getByRole('checkbox', { name: /README · pasted/ }).check();
  await expect(picker.getByText('1 selected')).toBeVisible();

  const marker = `stream-${randomUUID()}`;
  await mock.enqueue({ match: marker, chunks: ['Keep FTP ', 'enabled; ', 'it is **required**.'], delayMs: 120 });
  const box = panel(page).getByRole('textbox', { name: 'Message Claude' });
  await box.fill(`Which services must stay on? ${marker}`);
  await box.press('Enter');

  // Optimistic prompt, composer locked while streaming, then the streamed reply.
  await expect(conversation(page).getByText(`Which services must stay on? ${marker}`)).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(box).toBeDisabled();
  await expect(conversation(page).getByText('Keep FTP enabled;')).toBeVisible();
  await expect(conversation(page).locator('strong', { hasText: 'required' })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(box).toBeEnabled();
  await expect(conversation(page).getByRole('list', { name: 'Attached context' }).getByText('README · pasted')).toBeVisible();

  // The server's key went to the mock; the browser never saw it.
  const req = (await mock.requests()).find((r) => JSON.stringify(r.body).includes(marker));
  expect(req?.apiKey).toBe('test-key');
  expect(await page.content()).not.toContain('test-key');

  // Persisted: reload shows the conversation, its title and the chip.
  await page.reload();
  await expect(conversation(page).getByText(`Which services must stay on? ${marker}`)).toBeVisible();
  await expect(conversation(page).getByText('Keep FTP enabled;')).toBeVisible();
  await expect(conversation(page).getByText('README · pasted')).toBeVisible();
  await expect(panel(page).getByRole('combobox', { name: 'Conversation' })).toContainText('Which services must stay on?');
  await expect(panel(page).getByText('Mode: General')).toBeVisible();
});

test('a mid-stream 529 keeps the prompt, shows the error, and Retry recovers without duplicating it', async ({ page }) => {
  await signIn(page);
  await newSession(page, 'Claude retry');
  await openClaude(page);

  const marker = `retry-${randomUUID()}`;
  await mock.enqueue(
    { match: marker, chunks: ['Partial ', 'answer ', 'lost'], failAfter: 2, failWith: 'overloaded', delayMs: 50 },
    { match: marker, chunks: ['Recovered ', 'full answer.'] },
  );
  const prompt = `Adapt my script ${marker}`;
  const box = panel(page).getByRole('textbox', { name: 'Message Claude' });
  await box.fill(prompt);
  await panel(page).getByRole('button', { name: 'Send' }).click();

  const alert = conversation(page).getByRole('alert');
  await expect(alert).toContainText('Claude is overloaded right now');
  await expect(conversation(page).getByText('Partial answer')).toBeVisible();
  await expect(conversation(page).getByText(prompt)).toHaveCount(1);

  // The failure is persisted: after a reload the prompt and the failed reply are still there.
  await page.reload();
  await expect(conversation(page).getByText(prompt)).toHaveCount(1);
  await expect(conversation(page).getByText('Partial answer')).toBeVisible();

  await conversation(page).getByRole('button', { name: 'Retry' }).click();
  await expect(conversation(page).getByText('Recovered full answer.')).toBeVisible();
  await expect(conversation(page).getByRole('alert')).toHaveCount(0);
  await expect(conversation(page).getByText(prompt)).toHaveCount(1);

  await page.reload();
  await expect(conversation(page).getByText('Recovered full answer.')).toBeVisible();
  await expect(conversation(page).getByText(prompt)).toHaveCount(1);
  const calls = (await mock.requests()).filter((r) => JSON.stringify(r.body).includes(marker));
  expect(calls).toHaveLength(2);
});

test('Claude key settings show only ••••last4 and the saved key is used for Claude', async ({ page }) => {
  await signIn(page);
  const key = `sk-ant-e2e-${randomUUID()}-WXYZ`;
  await page.goto('/app/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByText('Without your own key, Claude uses the workspace key')).toBeVisible();
  await page.getByLabel('Claude API key').fill(key);
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByRole('status')).toHaveText('Key saved.');
  await expect(page.getByTestId('claude-key-masked')).toHaveText('••••WXYZ');
  await expect(page.getByLabel('Claude API key')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('claude-key-masked')).toHaveText('••••WXYZ');
  expect(await page.content()).not.toContain(key);

  // The saved key is the one Claude calls use.
  await page.goto('/app');
  await newSession(page, 'BYO key');
  const marker = `byo-${randomUUID()}`;
  await mock.enqueue({ match: marker, chunks: ['Using your key.'] });
  const box = panel(page).getByRole('textbox', { name: 'Message Claude' });
  await box.fill(`hello ${marker}`);
  await box.press('Enter');
  await expect(conversation(page).getByText('Using your key.')).toBeVisible();
  const req = (await mock.requests()).find((r) => JSON.stringify(r.body).includes(marker));
  expect(req?.apiKey).toBe(key);
  expect(await page.content()).not.toContain(key);

  // Remove.
  await page.goto('/app/settings');
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('status')).toHaveText('Key removed.');
  await expect(page.getByLabel('Claude API key')).toBeVisible();
  await expect(page.getByTestId('claude-key-masked')).toHaveCount(0);
});
