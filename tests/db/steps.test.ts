import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestUser, sql } from './helpers';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { createSessionFor } from '@/features/sessions/service';

let current: { id: string; email: string };
vi.mock('@/server/auth', () => ({ requireUser: async () => current }));

const { setStepStatus } = await import('@/features/flowchart/steps');

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
