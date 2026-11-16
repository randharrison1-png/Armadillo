import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestUser, sql } from './helpers';
import { testDatabaseUrl } from './env';
import { closePool } from '@/server/db/pool';
import { createSessionFor } from '@/features/sessions/service';

let current: { id: string; email: string };
vi.mock('@/server/auth', () => ({ requireUser: async () => current }));

const svc = await import('@/features/flowchart/service');

beforeAll(() => {
  process.env.DATABASE_URL ??= testDatabaseUrl();
});
afterAll(async () => {
  await closePool();
  await sql.end();
});

async function fresh() {
  current = await createTestUser();
  return createSessionFor(current.id, { title: 'Flow', os: 'linux' });
}
const stepRow = async (sessionId: string, step: string) =>
  (await sql`select status, notes from public.workflow_steps where session_id = ${sessionId} and step = ${step}::public.step_key`)[0]!;

describe('flowchart service', () => {
  it('status change persists and appends an event', async () => {
    const s = await fresh();
    const row = await svc.changeStepStatusFor(current.id, { sessionId: s.id, step: 'open_readme', status: 'in_progress', note: 'reading' });
    expect(row.status).toBe('in_progress');
    expect(await stepRow(s.id, 'open_readme')).toMatchObject({ status: 'in_progress', notes: 'reading' });
    const events = await sql`select from_status, to_status, cycle_no, note from public.workflow_step_events where session_id = ${s.id}`;
    expect(events).toEqual([{ from_status: 'not_started', to_status: 'in_progress', cycle_no: 1, note: 'reading' }]);
  });

  it('decision node never changes status automatically: loading data and checking a report write nothing', async () => {
    const s = await fresh();
    await sql`insert into public.leads_reports (owner_id, session_id, cycle_no, filename, raw_text) values (${current.id}, ${s.id}, 1, 'r.txt', 'x')`;
    const before = await sql`select step, status from public.workflow_steps where session_id = ${s.id} order by step`;
    const data = await svc.getFlowchartDataFor(current.id, s.id);
    expect(data?.latestReport?.filename).toBe('r.txt');
    const after = await sql`select step, status from public.workflow_steps where session_id = ${s.id} order by step`;
    expect(after).toEqual(before);
    expect(await sql`select 1 from public.workflow_step_events where session_id = ${s.id}`).toHaveLength(0);
    expect(await sql`select 1 from public.sessions where id = ${s.id} and current_cycle = 1 and status = 'active'`).toHaveLength(1);
  });

  it('refuses Complete and Verified on an evidence-bearing step without evidence, accepts with it', async () => {
    const s = await fresh();
    await expect(svc.changeStepStatusFor(current.id, { sessionId: s.id, step: 'run_hardening', status: 'verified' })).rejects.toThrow(
      'Attach evidence before marking this step Complete and Verified',
    );
    expect((await stepRow(s.id, 'run_hardening')).status).toBe('not_started');
    expect(await sql`select 1 from public.workflow_step_events where session_id = ${s.id}`).toHaveLength(0);
    await sql`insert into public.evidence (owner_id, session_id, step, kind, note) values (${current.id}, ${s.id}, 'run_hardening', 'execution_output', 'ran')`;
    await svc.changeStepStatusFor(current.id, { sessionId: s.id, step: 'run_hardening', status: 'verified' });
    expect((await stepRow(s.id, 'run_hardening')).status).toBe('verified');
  });

  it('evidence for another step does not satisfy the guard; other steps may be verified manually', async () => {
    const s = await fresh();
    await sql`insert into public.evidence (owner_id, session_id, step, kind) values (${current.id}, ${s.id}, 'run_hardening', 'other')`;
    for (const step of ['check_points', 'submit_final'] as const) {
      await expect(svc.changeStepStatusFor(current.id, { sessionId: s.id, step, status: 'verified' })).rejects.toThrow('Attach evidence');
    }
    await svc.changeStepStatusFor(current.id, { sessionId: s.id, step: 'open_readme', status: 'verified' });
    await svc.changeStepStatusFor(current.id, { sessionId: s.id, step: 'forensic_questions', status: 'verified' });
    expect((await stepRow(s.id, 'open_readme')).status).toBe('verified');
  });

  it('a LEADS report in the current cycle satisfies run_leads and inspect_leads', async () => {
    const s = await fresh();
    await expect(svc.changeStepStatusFor(current.id, { sessionId: s.id, step: 'run_leads', status: 'verified' })).rejects.toThrow('Attach evidence');
    await expect(svc.changeStepStatusFor(current.id, { sessionId: s.id, step: 'inspect_leads', status: 'verified' })).rejects.toThrow('Attach evidence');
    await sql`insert into public.leads_reports (owner_id, session_id, cycle_no, filename) values (${current.id}, ${s.id}, 1, 'r.txt')`;
    await svc.changeStepStatusFor(current.id, { sessionId: s.id, step: 'run_leads', status: 'verified' });
    await svc.changeStepStatusFor(current.id, { sessionId: s.id, step: 'inspect_leads', status: 'verified' });
  });

  it('only evidence from the current cycle counts once the session is past cycle 1', async () => {
    const s = await fresh();
    await sql`insert into public.evidence (owner_id, session_id, step, kind) values (${current.id}, ${s.id}, 'check_points', 'other')`;
    await sql`update public.sessions set current_cycle = 2 where id = ${s.id}`;
    // Cycle 2 has no step events yet: cycle-1 evidence does not carry over.
    await expect(svc.changeStepStatusFor(current.id, { sessionId: s.id, step: 'check_points', status: 'verified' })).rejects.toThrow('Attach evidence');
  });

  it('validates input and refuses completed sessions with a clear message', async () => {
    const s = await fresh();
    await expect(svc.changeStepStatusFor(current.id, { sessionId: s.id, step: 'nope' as never, status: 'in_progress' })).rejects.toThrow();
    await expect(svc.changeStepStatusFor(current.id, { sessionId: s.id, step: 'open_readme', status: 'in_progress', note: 'x'.repeat(2001) })).rejects.toThrow();
    await sql`update public.sessions set status = 'completed', completed_at = now() where id = ${s.id}`;
    await expect(svc.changeStepStatusFor(current.id, { sessionId: s.id, step: 'open_readme', status: 'in_progress' })).rejects.toThrow(
      'This session is completed and read-only',
    );
    await expect(svc.updateStepNotesFor(current.id, { sessionId: s.id, step: 'open_readme', notes: 'n' })).rejects.toThrow('completed and read-only');
  });

  it('saves notes without a status event and logs the edit', async () => {
    const s = await fresh();
    await svc.updateStepNotesFor(current.id, { sessionId: s.id, step: 'run_leads', notes: 'wait for VM' });
    expect((await stepRow(s.id, 'run_leads')).notes).toBe('wait for VM');
    expect(await sql`select 1 from public.workflow_step_events where session_id = ${s.id}`).toHaveLength(0);
    expect(await sql`select 1 from public.activity_log where session_id = ${s.id} and action = 'step.notes_updated'`).toHaveLength(1);
    await expect(svc.updateStepNotesFor(current.id, { sessionId: s.id, step: 'run_leads', notes: 'y'.repeat(2001) })).rejects.toThrow();
  });

  it('loads statuses, notes, evidence, history and the latest report/script; other users see nothing', async () => {
    const s = await fresh();
    await svc.changeStepStatusFor(current.id, { sessionId: s.id, step: 'open_readme', status: 'in_progress' });
    await svc.updateStepNotesFor(current.id, { sessionId: s.id, step: 'open_readme', notes: 'n1' });
    await sql`insert into public.evidence (owner_id, session_id, step, kind, note) values (${current.id}, ${s.id}, 'open_readme', 'other', 'e1')`;
    const data = await svc.getFlowchartDataFor(current.id, s.id);
    expect(data?.steps).toHaveLength(9);
    expect(data?.steps.find((x) => x.step === 'open_readme')).toMatchObject({ status: 'in_progress', notes: 'n1' });
    expect(data?.evidence).toMatchObject([{ step: 'open_readme', note: 'e1' }]);
    expect(data?.events).toMatchObject([{ step: 'open_readme', toStatus: 'in_progress', cycleNo: 1 }]);
    expect(data?.latestReport).toBeNull();
    expect(data?.latestSessionScript).toBeNull();
    const other = await createTestUser();
    expect(await svc.getFlowchartDataFor(other.id, s.id)).toBeNull();
  });
});
