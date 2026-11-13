import 'server-only';
import { logActivity } from '@/server/activity';
import { requireUser } from '@/server/auth';
import { withUser } from '@/server/db/withUser';
import type { StepKey, StepStatus, WorkflowStep } from '@/lib/types';

export { STEP_LABEL, STEP_ORDER, currentStep, stageLabel } from './stepMeta';

/**
 * Sets one workflow step's status for the signed-in user's session. In one transaction it updates
 * workflow_steps (status, and notes when `note` is given), appends a workflow_step_events row
 * (from/to status, the session's current cycle, note) and an activity entry.
 * A request that does not change the status is a no-op: nothing is written.
 * Throws if the session/step is not found (or not owned), or the session is completed.
 */
export async function setStepStatus(input: {
  sessionId: string;
  step: StepKey;
  status: StepStatus;
  note?: string;
}): Promise<WorkflowStep> {
  const user = await requireUser();
  return withUser(user.id, async (tx) => {
    const [session] = await tx<{ current_cycle: number }[]>`
      select current_cycle from public.sessions where id = ${input.sessionId}`;
    if (!session) throw new Error('Session not found');
    const [step] = await tx<WorkflowStep[]>`
      select * from public.workflow_steps where session_id = ${input.sessionId} and step = ${input.step}::public.step_key for update`;
    if (!step) throw new Error('Workflow step not found');
    if (step.status === input.status) return step;

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
  });
}
