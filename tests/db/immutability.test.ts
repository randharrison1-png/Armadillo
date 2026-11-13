import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createTestUser, sql } from './helpers';
import {
  CORE_TABLES,
  INSERT_ONLY_TABLES,
  type Graph,
  buildGraph,
  completeSession,
  factories,
  graphRowId,
  insertRow,
  pgError,
  probeUpdate,
} from './coreFixtures';

afterAll(async () => {
  await sql.end();
});

class Rollback extends Error {}

/** Runs `fn` as service_role (bypasses RLS, full table privileges) and always rolls back. */
async function asService<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let result: T;
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe('set local role service_role');
      result = await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result!;
}

/** Runs `fn` as the superuser inside a transaction that is always rolled back. */
async function asAdmin<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let result: T;
  try {
    await sql.begin(async (tx) => {
      result = await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result!;
}

const INSERT_ONLY = /is insert-only/;

describe('insert-only tables', () => {
  let a: Graph;

  beforeAll(async () => {
    a = await buildGraph((await createTestUser()).id);
  });

  for (const table of INSERT_ONLY_TABLES) {
    describe(table, () => {
      it('UPDATE raises (superuser, service_role and owner)', async () => {
        const id = graphRowId[table](a);
        const admin = await pgError(asAdmin((tx) => tx`update ${tx(table)} set ${tx(probeUpdate[table])} where id = ${id}`));
        expect(admin.message).toMatch(INSERT_ONLY);
        const service = await pgError(asService((tx) => tx`update ${tx(table)} set ${tx(probeUpdate[table])} where id = ${id}`));
        expect(service.message).toMatch(INSERT_ONLY);
        const owner = await pgError(asUser(a.owner, (tx) => tx`update ${tx(table)} set ${tx(probeUpdate[table])} where id = ${id}`));
        expect(owner.message).toMatch(/permission denied/);
      });

      it('DELETE raises (superuser, service_role and owner)', async () => {
        const id = graphRowId[table](a);
        const admin = await pgError(asAdmin((tx) => tx`delete from ${tx(table)} where id = ${id}`));
        expect(admin.message).toMatch(INSERT_ONLY);
        const service = await pgError(asService((tx) => tx`delete from ${tx(table)} where id = ${id}`));
        expect(service.message).toMatch(INSERT_ONLY);
        const owner = await pgError(asUser(a.owner, (tx) => tx`delete from ${tx(table)} where id = ${id}`));
        expect(owner.message).toMatch(/permission denied/);
      });

      it('TRUNCATE raises', async () => {
        const err = await pgError(asAdmin((tx) => tx`truncate ${tx(table)} cascade`));
        expect(err.message).toMatch(INSERT_ONLY);
      });

      it('the owner can still insert and read', async () => {
        const rows = await asUser(a.owner, async (tx) => {
          const id = await insertRow(tx, table, factories[table](a));
          return tx`select id from ${tx(table)} where id = ${id}`;
        });
        expect(rows).toHaveLength(1);
      });
    });
  }

  it('deleting a script that has versions is refused (versions stay recoverable)', async () => {
    const owner = await pgError(asUser(a.owner, (tx) => tx`delete from scripts where id = ${a.universalScriptId}`));
    expect(owner.message).toMatch(INSERT_ONLY);
    const [row] = await sql`select count(*)::int as n from script_versions where script_id = ${a.universalScriptId}`;
    expect(row.n).toBe(1);
  });

  it('an archived universal script keeps its versions', async () => {
    const versions = await asUser(a.owner, async (tx) => {
      await tx`update scripts set archived_at = now() where id = ${a.universalScriptId}`;
      return tx`select id from script_versions where script_id = ${a.universalScriptId}`;
    });
    expect(versions.map((r) => r.id)).toEqual([a.universalV1]);
  });

  it('trigger functions are not callable by API roles', async () => {
    const rows = await sql`
      select p.proname,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authed
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('forbid_mutation', 'assert_session_writable', 'forbid_completed_session_change')`;
    expect(rows.map((r) => r.proname).sort()).toEqual([
      'assert_session_writable',
      'forbid_completed_session_change',
      'forbid_mutation',
    ]);
    for (const r of rows) expect({ name: r.proname, anon: r.anon, authed: r.authed }).toEqual({ name: r.proname, anon: false, authed: false });
  });
});

describe('account deletion', () => {
  it('deleting an auth user removes their versions, events, activity and every other core row', async () => {
    const victim = (await createTestUser()).id;
    const bystander = await buildGraph((await createTestUser()).id);

    const active = await buildGraph(victim);
    const completed = await buildGraph(victim);
    await completeSession(completed);
    // Activity not tied to a session, and a second version chain on the universal script.
    await insertRow(sql, 'activity_log', { ...factories.activity_log(active), session_id: null });
    await insertRow(sql, 'script_versions', {
      ...factories.script_versions(active),
      script_id: active.universalScriptId,
      version_no: 2,
      base_version_id: active.universalV1,
    });

    const countFor = async (owner: string) => {
      const out: Record<string, number> = {};
      for (const table of CORE_TABLES) {
        const [r] = await sql`select count(*)::int as n from ${sql(table)} where owner_id = ${owner}`;
        out[table] = r.n;
      }
      return out;
    };
    const before = await countFor(victim);
    expect(Object.values(before).every((n) => n > 0)).toBe(true);
    const bystanderBefore = await countFor(bystander.owner);

    await sql`delete from auth.users where id = ${victim}`;

    expect(Object.values(await countFor(victim)).every((n) => n === 0)).toBe(true);
    expect(await countFor(bystander.owner)).toEqual(bystanderBefore);
  });

  it('does not depend on the order in which the auth.users cascades fire', async () => {
    // FK action triggers fire in trigger-name order (RI_ConstraintTrigger_a_<oid>). Re-creating the
    // sessions → auth.users FK gives it the newest oid, so the completed session row is deleted AFTER
    // its children: every child delete then sees a live, completed session and must still go through.
    const victim = (await createTestUser()).id;
    const g = await buildGraph(victim);
    await completeSession(g);
    const remaining = await asAdmin(async (tx) => {
      const [fk] = await tx`
        select conname from pg_constraint
        where conrelid = 'public.sessions'::regclass and contype = 'f' and confrelid = 'auth.users'::regclass`;
      await tx`alter table public.sessions drop constraint ${tx(fk.conname)}`;
      await tx`alter table public.sessions add constraint ${tx(fk.conname)}
               foreign key (owner_id) references auth.users (id) on delete cascade`;
      await tx`delete from auth.users where id = ${victim}`;
      const out: Record<string, number> = {};
      for (const table of CORE_TABLES) {
        const [r] = await tx`select count(*)::int as n from ${tx(table)} where owner_id = ${victim}`;
        out[table] = r.n;
      }
      return out;
    });
    expect(Object.values(remaining).every((n) => n === 0)).toBe(true);
  });
});
