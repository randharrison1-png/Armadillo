import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { DEFAULT_TEST_DATABASE_URL, testDatabaseUrl } from './env';

const root = join(import.meta.dirname, '..', '..');

function sqlFiles(dir: string): string[] {
  return readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(root, dir, f));
}

/**
 * Local run (DATABASE_URL unset or the default): `scripts/test-db.sh reset` starts the
 * bundled Postgres and rebuilds `armadillo_test` from shim + migrations.
 * External DB (e.g. the CI Postgres service container, DATABASE_URL pointing elsewhere): do not
 * touch the server; wipe the public/auth/paste schemas and re-apply shim + migrations.
 */
export default async function setup() {
  const url = testDatabaseUrl();
  if (url === DEFAULT_TEST_DATABASE_URL) {
    execFileSync('bash', [join(root, 'scripts', 'test-db.sh'), 'reset'], { stdio: 'inherit' });
    return;
  }
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe('drop schema if exists public cascade; create schema public; drop schema if exists auth cascade; drop schema if exists paste cascade');
    await admin.unsafe('grant all on schema public to public');
    for (const file of [...sqlFiles('supabase/shim'), ...sqlFiles('supabase/migrations')]) {
      await admin.unsafe(readFileSync(file, 'utf8'));
    }
  } finally {
    await admin.end();
  }
}
