export const DEFAULT_TEST_DATABASE_URL = 'postgres://postgres@127.0.0.1:54329/armadillo_test';

export function testDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}
