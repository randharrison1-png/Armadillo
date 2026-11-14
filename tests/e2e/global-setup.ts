import resetTestDatabase from '../db/globalSetup';
import { E2E_ANTHROPIC_MOCK_PORT, startAnthropicMock } from '../support/anthropic-mock';

/**
 * Rebuilds the e2e database (shim + migrations) before any test runs, using the same logic as
 * `pnpm test:db`: local runs restart/reset the bundled Postgres via scripts/test-db.sh, CI wipes
 * the disposable *_test database it points at. Also starts the Anthropic mock for the run.
 *
 * Playwright starts `webServer` before globalSetup. That is safe here: the app opens its pool
 * lazily and the readiness probe (/login without a cookie) never touches the database, so the
 * reset finishes before the first query. A reused local server's idle connections are dropped by
 * the reset and postgres.js reconnects on the next query.
 */
export default async function globalSetup() {
  await resetTestDatabase();
  // Local Anthropic Messages API stand-in; playwright.config.ts points ANTHROPIC_BASE_URL here.
  // Tests drive it through AnthropicMockClient (HTTP control endpoints under /__mock/).
  const mock = await startAnthropicMock({ port: E2E_ANTHROPIC_MOCK_PORT });
  return async () => {
    await mock.close();
  };
}
