import 'server-only';
import { logActivity } from '@/server/activity';
import { requireUser } from '@/server/auth';
import { withUser, type Tx } from '@/server/db/withUser';
import type { StepKey, StepStatus, WorkflowStep } from '@/lib/types';
import { EVIDENCE_REQUIRED_MESSAGE, EVIDENCE_STEPS, FlowchartError, REPORT_STEPS } from './types';

export { STEP_LABEL, STEP_ORDER, currentStep, stageLabel } from './stepMeta';

/**
 * Sets one workflow step's status for the signed-in user's session. In one transaction it updates
 * workflow_steps (status, and notes when `note` is given), appends a workflow_step_events row
 * (from/to status, the session's current cycle, note) and an activity entry.
 * A request that does not change the status is a no-op: nothing is written.
 * Throws if the session/step is not found (or not owned), or the session is completed.
 */
export async function setStepStatus(input: StepStatusInput): Promise<WorkflowStep> {
  const user = await requireUser();
  return withUser(user.id, (tx) => setStepStatusTx(tx, input));
}

export type StepStatusInput = { sessionId: string; step: StepKey; status: StepStatus; note?: string };

/** setStepStatus inside the caller's transaction (`tx` from withUser), so it commits or rolls back with the caller's own writes. */
export async function setStepStatusTx(tx: Tx, input: StepStatusInput): Promise<WorkflowStep> {
  {
    // Lock order: step row, then session row (shared), so current_cycle and the evidence we check
    // cannot change under us before the write commits.
    const [step] = await tx<WorkflowStep[]>`
      select * from public.workflow_steps where session_id = ${input.sessionId} and step = ${input.step}::public.step_key for update`;
    if (!step) throw new Error('Workflow step not found');
    const [session] = await tx<{ current_cycle: number }[]>`
      select current_cycle from public.sessions where id = ${input.sessionId} for share`;
    if (!session) throw new Error('Session not found');
    if (step.status === input.status) return step;
    // Audit accuracy (spec 10): never record Complete and Verified without evidence.
    if (input.status === 'verified' && EVIDENCE_STEPS.includes(input.step) && !(await hasEvidence(tx, input.sessionId, input.step, session.current_cycle))) {
      throw new FlowchartError(EVIDENCE_REQUIRED_MESSAGE);
    }

    const [updated] = await tx<WorkflowStep[]>`
      update public.workflow_steps
      set status = ${input.status}::public.step_status, notes = ${input.note === undefined ? step.notes : input.note}
      where id = ${step.id}
      returning *`;
    await tx`
      insert into public.workflow_step_events (session_id, step, from_status, to_status, cycle_no, note)
      values (${input.sessionId}, ${input.step}::public.step_key, ${step.status}::public.step_status,
              ${input.status}::public.step_status, ${session.current_cycle}, ${input.note ?? null})`;
    await logActivity(tx, {
      action: 'step.status_changed',
      entityType: 'workflow_step',
      entityId: step.id,
      sessionId: input.sessionId,
      meta: { step: input.step, from: step.status, to: input.status },
    });
    return updated;
  }
}

/**
 * Evidence exists for `step` in the session's current cycle. Evidence has no cycle column: cycle 1
 * counts everything; later cycles count rows created since the cycle's first step event.
 * LEADS steps are also satisfied by a LEADS report of the current cycle (inspect_leads: only a report).
 */
async function hasEvidence(tx: Tx, sessionId: string, step: StepKey, cycle: number): Promise<boolean> {
  if (REPORT_STEPS.includes(step)) {
    const [r] = await tx`select 1 from public.leads_reports where session_id = ${sessionId} and cycle_no = ${cycle} limit 1`;
    if (r) return true;
  }
  if (step === 'inspect_leads') return false;
  let since: Date | null = null;
  if (cycle > 1) {
    const [e] = await tx<{ start: Date | null }[]>`
      select min(created_at) as start from public.workflow_step_events where session_id = ${sessionId} and cycle_no = ${cycle}`;
    if (!e?.start) return false;
    since = e.start;
  }
  const [row] = await tx`
    select 1 from public.evidence where session_id = ${sessionId} and step = ${step}::public.step_key
    ${since ? tx`and created_at >= ${since}` : tx``} limit 1`;
  return !!row;
}
