import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestUser, sql } from './helpers';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { createSessionFor } from '@/features/sessions/service';

let current: { id: string; email: string };
vi.mock('@/server/auth', () => ({ requireUser: async () => current }));

const { setStepStatus, setStepStatusTx } = await import('@/features/flowchart/steps');
const { withUser } = await import('@/server/db/withUser');

beforeAll(() => {
  process.env.DATABASE_URL ??= testDatabaseUrl();
});
afterAll(async () => {
  await closePool();
  await sql.end();
});

async function fresh() {
  current = await createTestUser();
  const s = await createSessionFor(current.id, { title: 'Steps', os: 'linux' });
  return s;
}

describe('setStepStatus', () => {
  it('updates the step, writes an event with from/to/cycle/note, and logs activity', async () => {
    const s = await fresh();
    const row = await setStepStatus({ sessionId: s.id, step: 'open_readme', status: 'in_progress', note: 'started' });
    expect(row).toMatchObject({ session_id: s.id, step: 'open_readme', status: 'in_progress', notes: 'started' });
    const events = await sql`select * from public.workflow_step_events where session_id = ${s.id}`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ step: 'open_readme', from_status: 'not_started', to_status: 'in_progress', cycle_no: 1, note: 'started' });
    const log = await sql`select action, entity_type, meta from public.activity_log where session_id = ${s.id} and action = 'step.status_changed'`;
    expect(log).toHaveLength(1);
    expect(log[0].meta).toMatchObject({ step: 'open_readme', from: 'not_started', to: 'in_progress' });
  });

  it('keeps existing notes when no note is given and uses the session cycle', async () => {
    const s = await fresh();
    await setStepStatus({ sessionId: s.id, step: 'run_leads', status: 'blocked', note: 'waiting' });
    await sql`update public.sessions set current_cycle = 2 where id = ${s.id}`;
    await sql`insert into public.leads_reports (owner_id, session_id, cycle_no, filename) values (${current.id}, ${s.id}, 2, 'r.txt')`;
    const row = await setStepStatus({ sessionId: s.id, step: 'run_leads', status: 'verified' });
    expect(row.notes).toBe('waiting');
    const [ev] = await sql`select cycle_no, from_status from public.workflow_step_events where session_id = ${s.id} and to_status = 'verified'`;
    expect(ev).toMatchObject({ cycle_no: 2, from_status: 'blocked' });
  });

  it('moves sessions.updated_at forward on a step change', async () => {
    const s = await fresh();
    const [{ t: before }] = await sql`select updated_at as t from public.sessions where id = ${s.id}`;
    await setStepStatus({ sessionId: s.id, step: 'open_readme', status: 'in_progress' });
    const [{ t: after }] = await sql`select updated_at as t from public.sessions where id = ${s.id}`;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('is a no-op without an event when the status is unchanged', async () => {
    const s = await fresh();
    const row = await setStepStatus({ sessionId: s.id, step: 'check_points', status: 'not_started', note: 'ignored' });
    expect(row.status).toBe('not_started');
    expect(row.notes).toBeNull();
    const [{ n }] = await sql`select count(*)::int as n from public.workflow_step_events where session_id = ${s.id}`;
    expect(n).toBe(0);
  });

  it("cannot touch another user's session", async () => {
    const s = await fresh();
    current = await createTestUser();
    await expect(setStepStatus({ sessionId: s.id, step: 'open_readme', status: 'verified' })).rejects.toThrow();
    const [{ n }] = await sql`select count(*)::int as n from public.workflow_step_events where session_id = ${s.id}`;
    expect(n).toBe(0);
  });
});

describe('setStepStatusTx', () => {
  it('runs in the caller transaction: commits with it and rolls back with it', async () => {
    const s = await fresh();
    await expect(
      withUser(current.id, async (tx) => {
        await setStepStatusTx(tx, { sessionId: s.id, step: 'open_readme', status: 'in_progress' });
        throw new Error('caller failed');
      }),
    ).rejects.toThrow('caller failed');
    expect((await sql`select status from public.workflow_steps where session_id = ${s.id} and step = 'open_readme'`)[0].status).toBe('not_started');
    expect(await sql`select 1 from public.workflow_step_events where session_id = ${s.id}`).toHaveLength(0);

    const row = await withUser(current.id, (tx) => setStepStatusTx(tx, { sessionId: s.id, step: 'open_readme', status: 'in_progress' }));
    expect(row.status).toBe('in_progress');
    expect(await sql`select 1 from public.workflow_step_events where session_id = ${s.id}`).toHaveLength(1);
  });
});

describe('setStepStatusTx evidence guard', () => {
  const verify = (sessionId: string, step: 'run_hardening' | 'open_readme') =>
    withUser(current.id, (tx) => setStepStatusTx(tx, { sessionId, step, status: 'verified' }));

  it('refuses verified on an evidence-bearing step without evidence, allows it with evidence', async () => {
    const s = await fresh();
    await expect(verify(s.id, 'run_hardening')).rejects.toThrow('Attach evidence before marking this step Complete and Verified');
    expect(await sql`select 1 from public.workflow_step_events where session_id = ${s.id}`).toHaveLength(0);
    await sql`insert into public.evidence (owner_id, session_id, step, kind) values (${current.id}, ${s.id}, 'run_hardening', 'other')`;
    expect((await verify(s.id, 'run_hardening')).status).toBe('verified');
  });

  it('does not guard steps that may be verified manually, and throws explicitly for a missing step row', async () => {
    const s = await fresh();
    expect((await verify(s.id, 'open_readme')).status).toBe('verified');
    await sql`delete from public.workflow_steps where session_id = ${s.id} and step = 'run_hardening'`;
    await expect(verify(s.id, 'run_hardening')).rejects.toThrow('Workflow step not found');
  });
});

describe('setStepStatusTx concurrency (lock order: session row, then step row)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('two concurrent changes to different steps of one session both succeed (no deadlock)', async () => {
    for (let i = 0; i < 5; i++) {
      const s = await fresh();
      const results = await Promise.allSettled([
        setStepStatus({ sessionId: s.id, step: 'open_readme', status: 'in_progress' }),
        setStepStatus({ sessionId: s.id, step: 'forensic_questions', status: 'in_progress' }),
        setStepStatus({ sessionId: s.id, step: 'claude_adaptation', status: 'blocked' }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    }
  });

  it('a guarded verify waits for a concurrent cycle bump and checks the new cycle', async () => {
    const s = await fresh();
    await sql`insert into public.leads_reports (owner_id, session_id, cycle_no, filename) values (${current.id}, ${s.id}, 1, 'c1.txt')`;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const bump = sql.begin(async (tx) => {
      await tx`select 1 from public.sessions where id = ${s.id} for update`;
      await tx`update public.sessions set current_cycle = current_cycle + 1 where id = ${s.id}`;
      await held;
    });
    await sleep(150);
    let settled = false;
    const verify = setStepStatus({ sessionId: s.id, step: 'run_leads', status: 'verified' }).then(
      () => ((settled = true), 'ok'),
      (e: Error) => ((settled = true), e.message),
    );
    await sleep(300);
    expect(settled).toBe(false); // serialized behind the bump
    release();
    await bump;
    // Cycle 2 has no LEADS report: the cycle-1 report must not count.
    expect(await verify).toBe('Attach evidence before marking this step Complete and Verified');
    expect((await sql`select status from public.workflow_steps where session_id = ${s.id} and step = 'run_leads'`)[0]!.status).toBe('not_started');
  });
});
