import type { Requirement, WorkState } from '@/lib/types';

/**
 * Work state of a requirement (spec §5.3: proposed, implemented/reported and verified are kept
 * apart; Claude's assessment of a script is never proof the machine is hardened).
 *
 *   proposed → reported   the requirement is covered by a script version (coverage 'covered' with
 *                         script_version_id) and that script was reported run (Task 18 calls this
 *                         when execution output is uploaded). A potentially disruptive requirement
 *                         must first have been reviewed explicitly by the user (reviewed_at).
 *   reported → verified   only with verification evidence (a LEADS report id).
 *   proposed → verified   only for a manual task (coverage 'manual'), and only with evidence.
 *
 * Everything else — including staying in place, any move back, and anything out of 'verified' —
 * throws InvalidTransitionError. Pure: returns a new object, never touches the input.
 */

export class InvalidTransitionError extends Error {
  readonly name = 'InvalidTransitionError';
  constructor(
    readonly from: WorkState,
    readonly to: WorkState,
    readonly reason: string,
  ) {
    super(`Cannot move a requirement from ${from} to ${to}: ${reason}`);
  }
}

export type Evidence = { reportId: string };

const hasEvidence = (e: Evidence | undefined): e is Evidence => typeof e?.reportId === 'string' && e.reportId.trim() !== '';

export function transition<R extends Requirement>(r: R, to: WorkState, evidence?: Evidence): R {
  const from = r.work_state;
  const fail = (reason: string): never => {
    throw new InvalidTransitionError(from, to, reason);
  };
  if (from === 'verified') fail('verified is final');
  if (from === to) fail('it is already in that state');

  if (to === 'reported') {
    if (from !== 'proposed') fail('only a proposed requirement can be reported');
    if (r.coverage !== 'covered' || !r.script_version_id) fail('no script version covers it');
    if (r.disruptive && !r.reviewed_at) fail('it is potentially disruptive and has not been reviewed');
    return { ...r, work_state: 'reported' };
  }
  if (to === 'verified') {
    if (!hasEvidence(evidence)) fail('verification needs an evidence report');
    if (from === 'proposed' && r.coverage !== 'manual') fail('only a manual task can be verified without first being reported');
    return { ...r, work_state: 'verified', evidence_report_id: evidence!.reportId };
  }
  return fail('a requirement never moves back to proposed');
}
