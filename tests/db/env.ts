export const LOCAL_TEST_DB_PORT = Number(process.env.TEST_DB_PORT ?? 54329); // keep in sync with scripts/test-db.sh
export const DEFAULT_TEST_DATABASE_URL = `postgres://postgres@127.0.0.1:${LOCAL_TEST_DB_PORT}/armadillo_test`;

export function testDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

/** True when the URL targets the Postgres that scripts/test-db.sh manages (loopback host + its port). */
export function isLocalTestDb(url: string): boolean {
  const u = new URL(url);
  const port = u.port ? Number(u.port) : 5432;
  return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && port === LOCAL_TEST_DB_PORT;
}

/** The external-DB reset drops schemas, so only databases named *_test or *_ci are allowed. */
export function assertDisposableDatabase(url: string): void {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!/(_test|_ci)$/.test(name)) {
    throw new Error(
      `Refusing to reset database "${name}": the db test setup drops the public, auth and paste schemas, ` +
        'so DATABASE_URL must point at a database whose name ends in _test or _ci.',
    );
  }
}
