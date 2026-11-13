import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/armadillo_test';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm build && pnpm start --port ${PORT} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { DATABASE_URL, ARMADILLO_TEST_AUTH: '1', TEST_AUTH_SECRET: 'e2e-only-secret' },
  },
});
