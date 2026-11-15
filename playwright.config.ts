import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/armadillo_test';
// Test-only HMAC key for the ARMADILLO_TEST_AUTH cookie (>= 32 chars). Never used outside e2e.
const TEST_AUTH_SECRET = process.env.TEST_AUTH_SECRET ?? 'e2e-only-test-auth-secret-0123456789abcdef';
// The app talks to the local Anthropic mock (tests/support/anthropic-mock.ts, started in globalSetup),
// never the real API.
const ANTHROPIC_MOCK_PORT = Number(process.env.ANTHROPIC_MOCK_PORT ?? 3199);

// Nightly only (.github/workflows/nightly.yml, docs/testing.md): the acceptance spec runs against the real
// Claude API. The key comes from the environment (a CI secret), never from this file. The budget is small:
// a few thousand output tokens per structured call and a trimmed document context. The app's own
// retry on a transient API error (CLAUDE_MAX_RETRIES) stays on; the workflow turns Playwright's retries off.
const REAL_CLAUDE = process.env.ACCEPTANCE_REAL_CLAUDE === '1';
if (REAL_CLAUDE && !process.env.ANTHROPIC_API_KEY?.trim()) {
  throw new Error('ACCEPTANCE_REAL_CLAUDE=1 needs ANTHROPIC_API_KEY (the real Claude API key) in the environment.');
}
const claudeEnv: Record<string, string> = REAL_CLAUDE
  ? {
      ANTHROPIC_BASE_URL: '', // empty: the SDK's default endpoint
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!.trim(),
      CLAUDE_MAX_RETRIES: '2',
      CLAUDE_TOOL_MAX_TOKENS: process.env.ACCEPTANCE_CLAUDE_TOOL_MAX_TOKENS ?? '4096',
      CLAUDE_MAX_TOKENS: '1024',
      CLAUDE_CONTEXT_TOKENS: '20000',
      ...(process.env.ACCEPTANCE_CLAUDE_MODEL ? { CLAUDE_MODEL: process.env.ACCEPTANCE_CLAUDE_MODEL } : {}),
    }
  : {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${ANTHROPIC_MOCK_PORT}`,
      ANTHROPIC_API_KEY: 'test-key',
      CLAUDE_MAX_RETRIES: '0',
    };

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Production build, but the server process runs with NODE_ENV=test: the test auth provider
    // refuses to run when NODE_ENV is "production" at runtime (which `next start` defaults to).
    command: `pnpm build && NODE_ENV=test pnpm start --port ${PORT} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {
      DATABASE_URL,
      ARMADILLO_TEST_AUTH: '1',
      TEST_AUTH_SECRET,
      LOCAL_FILE_STORE_DIR: '.tmp/files',
      ...claudeEnv,
      // Test-only key-encryption secret (>= 32 chars) for saved Claude keys.
      KEY_ENCRYPTION_SECRET: 'e2e-only-key-encryption-secret-0123456789abcdef',
    },
  },
});
