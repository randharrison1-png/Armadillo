import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { sql } from './helpers';

/** Every test runs inside one transaction that is rolled back, so no seed row leaks into other files. */
class Rollback extends Error {}
async function inRollback(fn: (tx: postgres.TransactionSql) => Promise<void>) {
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

const CONTENT = 'Write-Host "seed"\r\nexit 0\r\n';
const SHA = createHash('sha256').update(CONTENT, 'utf8').digest('hex');

async function addSeed(tx: postgres.TransactionSql, filename = 'Seed-Test.ps1') {
  await tx`
    insert into library_seed.scripts (filename, name, category, function, description, os_compat, content, line_ending, language, sha256)
    values (${filename}, 'Seed test', 'leads_audit', 'leads_audit', 'test seed', '{windows,windows_server}', ${CONTENT}, 'crlf', 'powershell', ${SHA})`;
}
async function addUser(tx: postgres.TransactionSql) {
  const id = randomUUID();
  await tx`insert into auth.users (id, email) values (${id}, ${`seed-${id}@example.test`})`;
  return id;
}

afterAll(async () => {
  await sql.end();
});

describe('library seed (0007)', () => {
  it('copies every seed script into a new account as a universal v1 script it owns', async () => {
    await inRollback(async (tx) => {
      await addSeed(tx);
      const uid = await addUser(tx);
      const rows = await tx<{ filename: string; category: string; session_id: string | null; version_no: number; content: string; sha256: string; line_ending: string; author: string }[]>`
        select s.filename, s.category, s.session_id, v.version_no, v.content, v.sha256, v.line_ending, v.author
        from public.scripts s join public.script_versions v on v.id = s.current_version_id
        where s.owner_id = ${uid}`;
      expect(rows).toEqual([
        { filename: 'Seed-Test.ps1', category: 'leads_audit', session_id: null, version_no: 1, content: CONTENT, sha256: SHA, line_ending: 'crlf', author: 'user' },
      ]);
      const [log] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.activity_log where owner_id = ${uid} and action = 'script.seed'`;
      expect(log!.n).toBe(1);

      // the owner sees it through RLS
      await tx.unsafe('set local role authenticated');
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
      const visible = await tx<{ filename: string }[]>`select filename from public.scripts`;
      expect(visible.map((r) => r.filename)).toEqual(['Seed-Test.ps1']);
    });
  });

  it('copy_to_all reaches existing accounts once and never duplicates or overwrites', async () => {
    await inRollback(async (tx) => {
      const uid = await addUser(tx); // created before the seed exists
      await tx`
        insert into public.scripts (owner_id, name, filename, category, function, os_compat)
        values (${uid}, 'Mine', 'Other.ps1', 'windows', 'universal_hardening', '{windows}')`;
      await addSeed(tx);
      await addSeed(tx, 'Other.ps1'); // same filename as the user's own script
      const [first] = await tx<{ n: number }[]>`select library_seed.copy_to_all() as n`;
      expect(first!.n).toBeGreaterThanOrEqual(1);
      const [second] = await tx<{ n: number }[]>`select library_seed.copy_to_all() as n`;
      expect(second!.n).toBe(0);
      const rows = await tx<{ filename: string; name: string }[]>`
        select filename, name from public.scripts where owner_id = ${uid} order by filename`;
      expect(rows).toEqual([
        { filename: 'Other.ps1', name: 'Mine' },
        { filename: 'Seed-Test.ps1', name: 'Seed test' },
      ]);
    });
  });

  it('is invisible to clients: anon and authenticated cannot read the seeds or run the copy', async () => {
    for (const role of ['anon', 'authenticated']) {
      await expect(
        inRollback(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx`select filename from library_seed.scripts`;
        }),
      ).rejects.toThrow(/permission denied/);
      await expect(
        inRollback(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx`select library_seed.copy_to_all()`;
        }),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
