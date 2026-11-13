import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/armadillo_test';
// Test-only HMAC key for the ARMADILLO_TEST_AUTH cookie (>= 32 chars). Never used outside e2e.
const TEST_AUTH_SECRET = process.env.TEST_AUTH_SECRET ?? 'e2e-only-test-auth-secret-0123456789abcdef';

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
    env: { DATABASE_URL, ARMADILLO_TEST_AUTH: '1', TEST_AUTH_SECRET, LOCAL_FILE_STORE_DIR: '.tmp/files' },
  },
});
