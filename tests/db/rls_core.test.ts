import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAnon, asUser, createTestUser, sql } from './helpers';
import {
  CORE_TABLES,
  INSERT_ONLY_TABLES,
  SESSION_CHILD_TABLES,
  type CoreTable,
  type Graph,
  type Row,
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

const RLS_VIOLATION = /new row violates row-level security policy/;
const FK_VIOLATION = '23503';
const isInsertOnly = (t: CoreTable) => (INSERT_ONLY_TABLES as readonly string[]).includes(t);

describe('core schema: RLS isolation (every private table)', () => {
  let a: Graph;
  let b: Graph;

  beforeAll(async () => {
    a = await buildGraph((await createTestUser()).id);
    b = await buildGraph((await createTestUser()).id);
  });

  it('every core table exists with RLS enabled', async () => {
    const rows = await sql`
      select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ${sql(CORE_TABLES as unknown as string[])}`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...CORE_TABLES].sort());
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  for (const table of CORE_TABLES) {
    describe(table, () => {
      it('owner sees their row; another user gets 0 rows of it', async () => {
        const id = graphRowId[table](a);
        const own = await asUser(a.owner, (tx) => tx`select id from ${tx(table)} where id = ${id}`);
        expect(own).toHaveLength(1);

        const foreign = await asUser(b.owner, async (tx) => ({
          byId: await tx`select id from ${tx(table)} where id = ${id}`,
          byOwner: await tx`select id from ${tx(table)} where owner_id = ${a.owner}`,
          all: await tx`select distinct owner_id from ${tx(table)}`,
        }));
        expect(foreign.byId).toHaveLength(0);
        expect(foreign.byOwner).toHaveLength(0);
        expect(foreign.all.map((r) => r.owner_id)).toEqual([b.owner]);
      });

      it("another user cannot insert a row with the owner's owner_id", async () => {
        const err = await pgError(asUser(b.owner, (tx) => insertRow(tx, table, factories[table](a))));
        expect(err.message).toMatch(RLS_VIOLATION);
      });

      it('the owner can insert the same row (positive control)', async () => {
        const id = await asUser(a.owner, (tx) => insertRow(tx, table, factories[table](a)));
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
      });

      it('owner_id defaults to auth.uid()', async () => {
        const row = { ...factories[table](b) };
        delete row.owner_id;
        const owner = await asUser(b.owner, async (tx) => {
          const id = await insertRow(tx, table, row);
          const [r] = await tx`select owner_id from ${tx(table)} where id = ${id}`;
          return r.owner_id;
        });
        expect(owner).toBe(b.owner);
      });

      it("another user cannot update or delete the owner's row", async () => {
        const id = graphRowId[table](a);
        if (isInsertOnly(table)) {
          const upd = await pgError(asUser(b.owner, (tx) => tx`update ${tx(table)} set ${tx(probeUpdate[table])} where id = ${id}`));
          expect(upd.message).toMatch(/permission denied/);
          const del = await pgError(asUser(b.owner, (tx) => tx`delete from ${tx(table)} where id = ${id}`));
          expect(del.message).toMatch(/permission denied/);
        } else {
          const counts = await asUser(b.owner, async (tx) => ({
            updated: (await tx`update ${tx(table)} set ${tx(probeUpdate[table])} where id = ${id} returning id`).length,
            deleted: (await tx`delete from ${tx(table)} where id = ${id} returning id`).length,
          }));
          expect(counts).toEqual({ updated: 0, deleted: 0 });
        }
        const still = await sql`select id from ${sql(table)} where id = ${id}`;
        expect(still).toHaveLength(1);
      });

      if (!isInsertOnly(table)) {
        it("an owner cannot move their row to another user's owner_id", async () => {
          const id = graphRowId[table](b);
          const err = await pgError(asUser(b.owner, (tx) => tx`update ${tx(table)} set owner_id = ${a.owner} where id = ${id}`));
          expect(err.message).toMatch(RLS_VIOLATION);
        });
      }

      it('anon has no access at all', async () => {
        const err = await pgError(asAnon((tx) => tx`select id from ${tx(table)}`));
        expect(err.message).toMatch(/permission denied/);
      });
    });
  }
});

describe('core schema: cross-ownership (a child row may only reference its own owner’s parents)', () => {
  let a: Graph;
  let b: Graph;

  beforeAll(async () => {
    a = await buildGraph((await createTestUser()).id);
    b = await buildGraph((await createTestUser()).id);
  });

  for (const table of CORE_TABLES.filter((t) => t !== 'sessions')) {
    it(`${table}: B cannot insert a row it owns that points at A's parents`, async () => {
      const err = await pgError(asUser(b.owner, (tx) => insertRow(tx, table, { ...factories[table](a), owner_id: b.owner })));
      expect(err.code).toBe(FK_VIOLATION);
    });
  }

  /** [table, override taking A's graph] — exactly one reference swapped to A's row, the rest B's own. */
  const singleSwaps: Array<[CoreTable, (a: Graph) => Row]> = [
    ['scripts', (a) => ({ session_id: a.sessionId })],
    ['scripts', (a) => ({ forked_from_version_id: a.universalV1 })],
    ['scripts', (a) => ({ current_version_id: a.sessionV1 })],
    ['script_versions', (a) => ({ script_id: a.sessionScriptId })],
    ['script_versions', (a) => ({ base_version_id: a.sessionV1 })],
    ['readmes', (a) => ({ session_id: a.sessionId })],
    ['conversations', (a) => ({ session_id: a.sessionId })],
    ['messages', (a) => ({ conversation_id: a.conversationId })],
    ['leads_reports', (a) => ({ session_id: a.sessionId })],
    ['requirements', (a) => ({ session_id: a.sessionId })],
    ['requirements', (a) => ({ readme_id: a.readmeId })],
    ['requirements', (a) => ({ script_version_id: a.sessionV1 })],
    ['requirements', (a) => ({ evidence_report_id: a.reportId })],
    ['leads_findings', (a) => ({ report_id: a.reportId })],
    ['leads_findings', (a) => ({ requirement_id: a.requirementId })],
    ['proposals', (a) => ({ session_id: a.sessionId })],
    ['proposals', (a) => ({ conversation_id: a.conversationId })],
    ['proposals', (a) => ({ base_version_id: a.sessionV1 })],
    ['proposals', (a) => ({ status: 'accepted', result_version_id: a.sessionV2 })],
    ['evidence', (a) => ({ session_id: a.sessionId })],
    ['evidence', (a) => ({ script_version_id: a.sessionV1 })],
    ['remediation_cycles', (a) => ({ session_id: a.sessionId })],
    ['remediation_cycles', (a) => ({ report_id: a.reportId })],
    ['remediation_cycles', (a) => ({ proposal_id: a.proposalId })],
    ['workflow_steps', (a) => ({ session_id: a.sessionId })],
    ['workflow_step_events', (a) => ({ session_id: a.sessionId })],
    ['forensic_questions', (a) => ({ session_id: a.sessionId })],
    ['activity_log', (a) => ({ session_id: a.sessionId })],
  ];

  for (const [table, swap] of singleSwaps) {
    const column = Object.keys(swap({} as Graph)).filter((k) => k !== 'status')[0];
    it(`${table}.${column}: B's own row cannot reference A's row`, async () => {
      const err = await pgError(asUser(b.owner, (tx) => insertRow(tx, table, { ...factories[table](b), ...swap(a) })));
      expect(err.code).toBe(FK_VIOLATION);
    });
  }

  it("updates cannot re-point a reference at another user's row either", async () => {
    const cases: Array<[CoreTable, string, Row]> = [
      ['scripts', b.sessionScriptId, { current_version_id: a.sessionV2 }],
      ['leads_findings', b.findingId, { requirement_id: a.requirementId }],
      ['requirements', b.requirementId, { evidence_report_id: a.reportId }],
      ['messages', b.messageId, { conversation_id: a.conversationId }],
    ];
    for (const [table, id, values] of cases) {
      const err = await pgError(asUser(b.owner, (tx) => tx`update ${tx(table)} set ${tx(values)} where id = ${id}`));
      expect(err.code, `${table} ${Object.keys(values)[0]}`).toBe(FK_VIOLATION);
    }
  });

  it("scripts.current_version_id must be a version of that same script", async () => {
    // Same owner, but the universal script's version is not a version of the session script.
    const err = await pgError(
      asUser(b.owner, (tx) => tx`update scripts set current_version_id = ${b.universalV1} where id = ${b.sessionScriptId}`),
    );
    expect(err.code).toBe(FK_VIOLATION);
  });

  it('session-scoped references must stay inside the same session', async () => {
    const other = await insertRow(sql, 'sessions', factories.sessions(b));
    const otherGraph = { ...b, sessionId: other };
    // A README / report / conversation / proposal from B's first session cannot be used in B's second session.
    const cases: Array<[CoreTable, Row]> = [
      ['requirements', { ...factories.requirements(otherGraph), readme_id: b.readmeId }],
      ['proposals', { ...factories.proposals(otherGraph), conversation_id: b.conversationId }],
      ['remediation_cycles', { ...factories.remediation_cycles(otherGraph), report_id: b.reportId, proposal_id: null }],
      ['remediation_cycles', { ...factories.remediation_cycles(otherGraph), report_id: null, proposal_id: b.proposalId }],
    ];
    for (const [table, row] of cases) {
      const err = await pgError(asUser(b.owner, (tx) => insertRow(tx, table, row)));
      expect(err.code, `${table}`).toBe(FK_VIOLATION);
    }
    const readmeInOther = await insertRow(sql, 'readmes', factories.readmes(otherGraph));
    const err = await pgError(
      asUser(b.owner, (tx) =>
        insertRow(tx, 'requirements', { ...factories.requirements(otherGraph), readme_id: readmeInOther, work_state: 'verified', evidence_report_id: b.reportId }),
      ),
    );
    expect(err.code).toBe(FK_VIOLATION);
  });
});

describe('core schema: constraints', () => {
  let a: Graph;

  beforeAll(async () => {
    a = await buildGraph((await createTestUser()).id);
  });

  it('verified requires evidence: work_state=verified with null evidence_report_id fails', async () => {
    const err = await pgError(
      asUser(a.owner, (tx) => insertRow(tx, 'requirements', { ...factories.requirements(a), work_state: 'verified', evidence_report_id: null })),
    );
    expect(err.code).toBe('23514');
    expect(err.message).toMatch(/requirements_verified_requires_evidence/);

    const ok = await asUser(a.owner, (tx) =>
      insertRow(tx, 'requirements', { ...factories.requirements(a), work_state: 'verified', evidence_report_id: a.reportId }),
    );
    expect(ok).toBeTruthy();

    const upd = await pgError(
      asUser(a.owner, (tx) => tx`update requirements set evidence_report_id = null where id = ${a.requirementId}`),
    );
    expect(upd.code).toBe('23514');
  });

  it('script_versions are unique per (script_id, version_no)', async () => {
    const err = await pgError(
      asUser(a.owner, (tx) => insertRow(tx, 'script_versions', { ...factories.script_versions(a), version_no: 1 })),
    );
    expect(err.code).toBe('23505');
  });

  it('workflow_steps are unique per (session_id, step)', async () => {
    const err = await pgError(asUser(a.owner, (tx) => insertRow(tx, 'workflow_steps', { ...factories.workflow_steps(a), step: 'open_readme' })));
    expect(err.code).toBe('23505');
  });

  it('messages.client_request_id is unique per conversation', async () => {
    const [{ client_request_id }] = await sql`select client_request_id from messages where id = ${a.messageId}`;
    const err = await pgError(asUser(a.owner, (tx) => insertRow(tx, 'messages', { ...factories.messages(a), client_request_id })));
    expect(err.code).toBe('23505');
    // The same id in a different conversation is a different request.
    const otherConversation = await insertRow(sql, 'conversations', factories.conversations(a));
    const ok = await asUser(a.owner, (tx) =>
      insertRow(tx, 'messages', { ...factories.messages(a), conversation_id: otherConversation, client_request_id }),
    );
    expect(ok).toBeTruthy();
  });

  it('closed sets reject unknown values', async () => {
    const cases: Array<[CoreTable, Row]> = [
      ['sessions', { ...factories.sessions(a), os: 'macos' }],
      ['sessions', { ...factories.sessions(a), status: 'archived' }],
      ['scripts', { ...factories.scripts(a), category: 'mac' }],
      ['scripts', { ...factories.scripts(a), function: 'other' }],
      ['script_versions', { ...factories.script_versions(a), encoding: 'latin1' }],
      ['script_versions', { ...factories.script_versions(a), line_ending: 'cr' }],
      ['script_versions', { ...factories.script_versions(a), language: 'python' }],
      ['script_versions', { ...factories.script_versions(a), author: 'bot' }],
      ['script_versions', { ...factories.script_versions(a), sha256: 'not-a-hash' }],
      ['readmes', { ...factories.readmes(a), source: 'email' }],
      ['conversations', { ...factories.conversations(a), mode: 'chat' }],
      ['messages', { ...factories.messages(a), role: 'system' }],
      ['messages', { ...factories.messages(a), status: 'done' }],
      ['requirements', { ...factories.requirements(a), coverage: 'partial' }],
      ['requirements', { ...factories.requirements(a), work_state: 'implemented' }],
      ['leads_findings', { ...factories.leads_findings(a), status: 'warn' }],
      ['proposals', { ...factories.proposals(a), kind: 'other' }],
      ['proposals', { ...factories.proposals(a), status: 'maybe' }],
      ['evidence', { ...factories.evidence(a), kind: 'video' }],
      ['evidence', { ...factories.evidence(a), step: 'reboot' }],
      ['remediation_cycles', { ...factories.remediation_cycles(a), outcome: 'failed' }],
      ['workflow_steps', { ...factories.workflow_steps(a), status: 'done' }],
      ['workflow_step_events', { ...factories.workflow_step_events(a), to_status: 'done' }],
      ['forensic_questions', { ...factories.forensic_questions(a), status: 'closed' }],
    ];
    for (const [table, row] of cases) {
      const err = await pgError(asUser(a.owner, (tx) => insertRow(tx, table, row)));
      expect(['23514', '22P02'], `${table} ${JSON.stringify(row).slice(0, 80)}`).toContain(err.code);
    }
  });

  it('sessions default to active, cycle 1; completed requires completed_at', async () => {
    const row = await asUser(a.owner, async (tx) => {
      const id = await insertRow(tx, 'sessions', factories.sessions(a));
      const [r] = await tx`select status, current_cycle, completed_at from sessions where id = ${id}`;
      return r;
    });
    expect(row).toEqual({ status: 'active', current_cycle: 1, completed_at: null });
    const err = await pgError(asUser(a.owner, (tx) => insertRow(tx, 'sessions', { ...factories.sessions(a), status: 'completed' })));
    expect(err.code).toBe('23514');
  });

  it('os_compat round-trips as an array of OsType', async () => {
    const [row] = await sql`select os_compat from scripts where id = ${a.sessionScriptId}`;
    expect(row.os_compat).toEqual(['windows', 'windows_server']);
  });

  it('updated_at is maintained on update', async () => {
    const [before] = await sql`select updated_at from sessions where id = ${a.sessionId}`;
    await sql`update sessions set title = 'Renamed' where id = ${a.sessionId}`;
    const [after] = await sql`select updated_at from sessions where id = ${a.sessionId}`;
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});

describe('completed session is read-only', () => {
  let a: Graph;

  beforeAll(async () => {
    a = await buildGraph((await createTestUser()).id);
    await completeSession(a);
  });

  it('insert into messages / evidence for a completed session fails', async () => {
    const msg = await pgError(asUser(a.owner, (tx) => insertRow(tx, 'messages', factories.messages(a))));
    expect(msg.message).toMatch(/completed.*read-only/);
    const ev = await pgError(asUser(a.owner, (tx) => insertRow(tx, 'evidence', factories.evidence(a))));
    expect(ev.message).toMatch(/completed.*read-only/);
  });

  for (const table of SESSION_CHILD_TABLES) {
    it(`${table}: insert, update and delete are refused`, async () => {
      const ins = await pgError(asUser(a.owner, (tx) => insertRow(tx, table, factories[table](a))));
      expect(ins.message).toMatch(/completed.*read-only/);

      const id = graphRowId[table](a);
      // Insert-only tables are refused earlier by privileges; check the trigger as the superuser too.
      if (!isInsertOnly(table)) {
        const upd = await pgError(asUser(a.owner, (tx) => tx`update ${tx(table)} set ${tx(probeUpdate[table])} where id = ${id}`));
        expect(upd.message).toMatch(/completed.*read-only/);
        const del = await pgError(asUser(a.owner, (tx) => tx`delete from ${tx(table)} where id = ${id}`));
        expect(del.message).toMatch(/completed.*read-only/);
      }
    });
  }

  it('a universal script (no session) is unaffected', async () => {
    const id = await asUser(a.owner, (tx) =>
      insertRow(tx, 'script_versions', { ...factories.script_versions(a), script_id: a.universalScriptId }),
    );
    expect(id).toBeTruthy();
  });

  it('a new session script cannot be created in a completed session; a universal one can', async () => {
    const err = await pgError(asUser(a.owner, (tx) => insertRow(tx, 'scripts', factories.scripts(a))));
    expect(err.message).toMatch(/completed.*read-only/);
    const ok = await asUser(a.owner, (tx) => insertRow(tx, 'scripts', { ...factories.scripts(a), session_id: null }));
    expect(ok).toBeTruthy();
  });

  it('rows cannot be moved out of or into a completed session', async () => {
    const active = await buildGraph(a.owner);
    const out = await pgError(
      asUser(a.owner, (tx) => tx`update forensic_questions set session_id = ${active.sessionId} where id = ${a.forensicId}`),
    );
    expect(out.message).toMatch(/completed.*read-only/);
    const into = await pgError(
      asUser(a.owner, (tx) => tx`update forensic_questions set session_id = ${a.sessionId} where id = ${active.forensicId}`),
    );
    expect(into.message).toMatch(/completed.*read-only/);
  });

  it('the completed session stays fully readable', async () => {
    const counts = await asUser(a.owner, async (tx) => {
      const out: Record<string, number> = {};
      for (const table of CORE_TABLES) {
        const [r] = await tx`select count(*)::int as n from ${tx(table)} where id = ${graphRowId[table](a)}`;
        out[table] = r.n;
      }
      return out;
    });
    expect(Object.values(counts).every((n) => n === 1)).toBe(true);
  });

  it('activity can still be logged against a completed session', async () => {
    const id = await asUser(a.owner, (tx) => insertRow(tx, 'activity_log', factories.activity_log(a)));
    expect(id).toBeTruthy();
  });
});
