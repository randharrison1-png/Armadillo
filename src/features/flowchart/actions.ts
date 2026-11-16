'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/server/auth';
import { CycleDecisionError, decideCycleFor } from '@/features/reports/cycles';
import type { CycleDecision } from '@/features/reports/remediationRules';
import type { StepKey, StepStatus } from '@/lib/types';
import { changeStepStatusFor, FlowchartError, getFlowchartDataFor, updateStepNotesFor } from './service';
import type { FlowchartData } from './types';

type Result = { ok: true } | { ok: false; error: string };

function failure(e: unknown, fallback: string): Result {
  // Redirect/auth control-flow errors from requireUser carry a digest and must propagate.
  if (typeof e === 'object' && e !== null && 'digest' in e) throw e;
  if (e instanceof FlowchartError || e instanceof CycleDecisionError) return { ok: false, error: e.message };
  // A DB-level refusal (completed-session trigger) reads as a read-only session.
  console.error('[flowchart] action failed:', e instanceof Error ? e.name : 'unknown error');
  return { ok: false, error: fallback };
}

/** Everything the flowchart tab renders; null when the session is not the user's. */
export async function loadFlowchart(sessionId: string): Promise<FlowchartData | null> {
  const user = await requireUser();
  return getFlowchartDataFor(user.id, String(sessionId));
}

/** Changes one step's status (validated; refuses completed sessions and unevidenced Complete and Verified). */
export async function setStepStatusAction(input: { sessionId: string; step: StepKey; status: StepStatus; note?: string }): Promise<Result> {
  try {
    const user = await requireUser();
    await changeStepStatusFor(user.id, {
      sessionId: String(input.sessionId),
      step: input.step,
      status: input.status,
      note: input.note === undefined ? undefined : String(input.note),
    });
    revalidatePath(`/app/sessions/${input.sessionId}`);
    return { ok: true };
  } catch (e) {
    return failure(e, 'Could not save the status. Try again.');
  }
}

/** Saves one step's notes. */
export async function saveStepNotesAction(input: { sessionId: string; step: StepKey; notes: string }): Promise<Result> {
  try {
    const user = await requireUser();
    await updateStepNotesFor(user.id, { sessionId: String(input.sessionId), step: input.step, notes: String(input.notes) });
    return { ok: true };
  } catch (e) {
    return failure(e, 'Could not save the notes. Try again.');
  }
}

/** The decision node: "Mark complete" ('complete') or "Start another cycle" ('continue'), with the same enable rules the buttons show. */
export async function decideCycleAction(input: { sessionId: string; decision: CycleDecision }): Promise<Result> {
  try {
    const user = await requireUser();
    await decideCycleFor(user.id, { sessionId: String(input.sessionId), decision: input.decision });
    revalidatePath(`/app/sessions/${input.sessionId}`);
    return { ok: true };
  } catch (e) {
    return failure(e, 'Could not record the decision. Try again.');
  }
}
