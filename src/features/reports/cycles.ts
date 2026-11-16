import 'server-only';
import { logActivity } from '@/server/activity';
import { requireUser } from '@/server/auth';
import { withUser } from '@/server/db/withUser';
import { setStepStatusTx } from '@/features/flowchart/steps';
import type { StepKey, StepStatus } from '@/lib/types';
import { CYCLE_RESET_STEPS, decisionAvailability, READ_ONLY_REASON, type CycleDecision, type CycleOutcome } from './remediationRules';
import { isUuid } from './service';

/**
 * Audit cycles (spec §8.2–8.3, Task 17): the flowchart's decision node after "Check final points".
 *  - 'complete' ("Mark complete"): only when the current cycle's Check final points is Complete and
 *    Verified. Closes the cycle (remediation_cycles outcome 'completed') and moves Submit final from
 *    Not Started to In Progress. The session itself stays active: submitting is a separate step.
 *  - 'continue' ("Start another cycle"): only when the current cycle has at least one LEADS report.
 *    Closes the cycle as 'continued', increments sessions.current_cycle, and resets Run LEADS,
 *    Inspect LEADS report, Targeted remediation and Check final points to Not Started through
 *    setStepStatusTx, so every reset is a workflow_step_events row of the NEW cycle; earlier events,
 *    reports, proposals and scripts are kept (the history).
 * The enable rules are decisionAvailability, the same function the buttons use. "Mark complete" is
 * final for its cycle: afterwards neither decision is allowed, and no upsert overwrites 'completed'.
 *
 * Lock order (app-wide): the sessions row FOR UPDATE (current_cycle changes), THEN the workflow_steps
 * rows, THEN remediation_cycles. Concurrent decisions serialize on the session row; the loser re-reads
 * the new cycle and is refused by the same rules.
 */

/** A refusal whose message is safe to show (the decision node's tooltip texts). */
export class CycleDecisionError extends Error {
  readonly name = 'CycleDecisionError';
}

export type { CycleDecision };
export type CycleDecisionResult = { decision: CycleDecision; cycleNo: number; currentCycle: number };

const DECIDED_STEPS: readonly StepKey[] = [...CYCLE_RESET_STEPS, 'submit_final'];

const isReadOnlyError = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '55000';

export async function decideCycleFor(userId: string, input: { sessionId: string; decision: CycleDecision }): Promise<CycleDecisionResult> {
  const sessionId = String(input.sessionId);
  const decision = input.decision;
  if (decision !== 'complete' && decision !== 'continue') throw new CycleDecisionError('Choose Mark complete or Start another cycle.');
  if (!isUuid(sessionId)) throw new CycleDecisionError('Session not found');
  try {
    return await withUser(userId, async (tx) => {
      const [session] = await tx<{ status: 'active' | 'completed'; current_cycle: number }[]>`
        select status, current_cycle from public.sessions where id = ${sessionId} for update`;
      if (!session) throw new CycleDecisionError('Session not found');
      if (session.status === 'completed') throw new CycleDecisionError(READ_ONLY_REASON);
      const cycle = session.current_cycle;

      const steps = await tx<{ step: StepKey; status: StepStatus }[]>`
        select step, status from public.workflow_steps
        where session_id = ${sessionId} and step = any(${DECIDED_STEPS as string[]}::public.step_key[])
        order by step for update`;
      const status = (k: StepKey) => steps.find((s) => s.step === k)?.status ?? 'not_started';
      const [{ n: reports }] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.leads_reports where session_id = ${sessionId} and cycle_no = ${cycle}`;
      const [row] = await tx<{ id: string; outcome: CycleOutcome; report_id: string | null }[]>`
        select id, outcome, report_id from public.remediation_cycles where session_id = ${sessionId} and cycle_no = ${cycle} for update`;

      const rules = decisionAvailability({ sessionStatus: session.status, checkPoints: status('check_points'), currentCycle: cycle, currentCycleReports: reports, outcome: row?.outcome ?? null });
      const rule = decision === 'complete' ? rules.complete : rules.continue;
      if (!rule.enabled) throw new CycleDecisionError(rule.reason);

      const outcome: CycleOutcome = decision === 'complete' ? 'completed' : 'continued';
      if (decision === 'complete') {
        if (status('submit_final') === 'not_started') await setStepStatusTx(tx, { sessionId, step: 'submit_final', status: 'in_progress' });
      } else {
        await tx`update public.sessions set current_cycle = ${cycle + 1} where id = ${sessionId}`;
        // setStepStatusTx records each reset under the new cycle (it reads current_cycle in this transaction).
        for (const step of CYCLE_RESET_STEPS) await setStepStatusTx(tx, { sessionId, step, status: 'not_started' });
      }
      await tx`
        insert into public.remediation_cycles (session_id, cycle_no, report_id, outcome)
        values (${sessionId}, ${cycle},
                (select id from public.leads_reports where session_id = ${sessionId} and cycle_no = ${cycle} order by created_at desc, id desc limit 1),
                ${outcome})
        on conflict (session_id, cycle_no) do update
          set outcome = excluded.outcome, report_id = coalesce(public.remediation_cycles.report_id, excluded.report_id)
          where public.remediation_cycles.outcome <> 'completed'`;
      await logActivity(tx, {
        action: decision === 'complete' ? 'cycle.complete' : 'cycle.continue',
        entityType: 'session',
        entityId: sessionId,
        sessionId,
        meta: decision === 'complete' ? { cycle } : { from: cycle, to: cycle + 1, reset: [...CYCLE_RESET_STEPS] },
      });
      return { decision, cycleNo: cycle, currentCycle: decision === 'continue' ? cycle + 1 : cycle };
    });
  } catch (e) {
    if (isReadOnlyError(e)) throw new CycleDecisionError(READ_ONLY_REASON);
    throw e;
  }
}

/** Brief: the signed-in user's decision. Throws CycleDecisionError when the rules refuse it. */
export async function decideCycle(input: { sessionId: string; decision: CycleDecision }): Promise<void> {
  const user = await requireUser();
  await decideCycleFor(user.id, input);
}
