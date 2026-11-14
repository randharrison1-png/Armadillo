import 'server-only';
import { z } from 'zod';
import { logActivity } from '@/server/activity';
import { withUser, type Tx } from '@/server/db/withUser';
import type { StepKey, StepStatus, WorkflowStep } from '@/lib/types';
import { STEP_ORDER } from './stepMeta';
import { setStepStatusTx } from './steps';
import { FlowchartError, NOTE_MAX, READ_ONLY_MESSAGE, type FlowchartData } from './types';

export { FlowchartError };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stepKey = z.enum(STEP_ORDER as [StepKey, ...StepKey[]]);
const statusSchema = z.enum(['not_started', 'in_progress', 'verified', 'blocked']);
const statusInput = z.object({ sessionId: z.string().regex(UUID_RE), step: stepKey, status: statusSchema, note: z.string().max(NOTE_MAX).optional() });
const notesInput = z.object({ sessionId: z.string().regex(UUID_RE), step: stepKey, notes: z.string().max(NOTE_MAX) });

export type ChangeStatusInput = { sessionId: string; step: StepKey; status: StepStatus; note?: string };

async function openSession(tx: Tx, sessionId: string): Promise<{ current_cycle: number }> {
  const [s] = await tx<{ status: string; current_cycle: number }[]>`select status, current_cycle from public.sessions where id = ${sessionId}`;
  if (!s) throw new FlowchartError('Session not found');
  if (s.status === 'completed') throw new FlowchartError(READ_ONLY_MESSAGE);
  return s;
}

/** Validated, read-only-aware status change with the evidence guard for Complete and Verified. */
export function changeStepStatusFor(userId: string, input: ChangeStatusInput): Promise<WorkflowStep> {
  const parsed = statusInput.safeParse(input);
  if (!parsed.success) return Promise.reject(new FlowchartError('Invalid step or status'));
  const data = parsed.data;
  return withUser(userId, async (tx) => {
    await openSession(tx, data.sessionId);
    return setStepStatusTx(tx, data);
  });
}

/** Saves a step's notes (no status event) and logs the edit. */
export function updateStepNotesFor(userId: string, input: { sessionId: string; step: StepKey; notes: string }): Promise<WorkflowStep> {
  const parsed = notesInput.safeParse(input);
  if (!parsed.success) return Promise.reject(new FlowchartError(`Notes must be ${NOTE_MAX} characters or fewer`));
  const data = parsed.data;
  return withUser(userId, async (tx) => {
    await openSession(tx, data.sessionId);
    const [row] = await tx<WorkflowStep[]>`
      update public.workflow_steps set notes = ${data.notes}
      where session_id = ${data.sessionId} and step = ${data.step}::public.step_key returning *`;
    if (!row) throw new FlowchartError('Workflow step not found');
    await logActivity(tx, {
      action: 'step.notes_updated',
      entityType: 'workflow_step',
      entityId: row.id,
      sessionId: data.sessionId,
      meta: { step: data.step, length: data.notes.length },
    });
    return row;
  });
}

const iso = (d: Date) => d.toISOString();

/** Everything the flowchart tab shows, or null when the session is not the user's. */
export function getFlowchartDataFor(userId: string, sessionId: string): Promise<FlowchartData | null> {
  if (!UUID_RE.test(sessionId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const [session] = await tx<{ status: 'active' | 'completed'; current_cycle: number }[]>`
      select status, current_cycle from public.sessions where id = ${sessionId}`;
    if (!session) return null;
    const steps = await tx<{ step: StepKey; status: StepStatus; notes: string | null; updated_at: Date }[]>`
      select step, status, notes, updated_at from public.workflow_steps where session_id = ${sessionId}`;
    const evidence = await tx<{ id: string; step: StepKey; kind: string; note: string | null; created_at: Date }[]>`
      select id, step, kind, note, created_at from public.evidence where session_id = ${sessionId} order by created_at desc`;
    const events = await tx<{ id: string; step: StepKey; from_status: StepStatus | null; to_status: StepStatus; cycle_no: number; note: string | null; created_at: Date }[]>`
      select id, step, from_status, to_status, cycle_no, note, created_at from public.workflow_step_events
      where session_id = ${sessionId} order by created_at desc, id desc limit 500`;
    const [report] = await tx<{ id: string; filename: string; cycle_no: number }[]>`
      select id, filename, cycle_no from public.leads_reports where session_id = ${sessionId} order by created_at desc, id desc limit 1`;
    const [script] = await tx<{ id: string; filename: string }[]>`
      select id, filename from public.scripts
      where session_id = ${sessionId} and function = 'session_generated' and archived_at is null and current_version_id is not null
      order by updated_at desc, created_at desc limit 1`;
    return {
      sessionStatus: session.status,
      currentCycle: session.current_cycle,
      steps: steps.map((s) => ({ step: s.step, status: s.status, notes: s.notes, updatedAt: iso(s.updated_at) })),
      evidence: evidence.map((e) => ({ id: e.id, step: e.step, kind: e.kind, note: e.note, createdAt: iso(e.created_at) })),
      events: events.map((e) => ({ id: e.id, step: e.step, fromStatus: e.from_status, toStatus: e.to_status, cycleNo: e.cycle_no, note: e.note, createdAt: iso(e.created_at) })),
      latestReport: report ? { id: report.id, filename: report.filename, cycleNo: report.cycle_no } : null,
      latestSessionScript: script ? { scriptId: script.id, filename: script.filename } : null,
    };
  });
}
