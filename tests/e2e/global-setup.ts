import resetTestDatabase from '../db/globalSetup';

/**
 * Rebuilds the e2e database (shim + migrations) before any test runs, using the same logic as
 * `pnpm test:db`: local runs restart/reset the bundled Postgres via scripts/test-db.sh, CI wipes
 * the disposable *_test database it points at.
 *
 * Playwright starts `webServer` before globalSetup. That is safe here: the app opens its pool
 * lazily and the readiness probe (/login without a cookie) never touches the database, so the
 * reset finishes before the first query. A reused local server's idle connections are dropped by
 * the reset and postgres.js reconnects on the next query.
 */
export default async function globalSetup() {
  await resetTestDatabase();
}
