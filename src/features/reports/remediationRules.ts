// Pure rules for targeted remediation and audit cycles (Task 17). Client-safe: no server imports.
import { InvalidTransitionError, transition } from '@/features/requirements/statusMachine';
import type { Requirement, StepStatus } from '@/lib/types';

export type FindingStatus = 'pass' | 'fail' | 'unknown';
export type CycleOutcome = 'open' | 'completed' | 'continued';

/** Findings a remediation addresses: failing ones, and unknown ones (the report could not tell). Passing findings never. */
export function remediableFindings<F extends { status: FindingStatus }>(findings: readonly F[]): F[] {
  return findings.filter((f) => f.status === 'fail' || f.status === 'unknown');
}

// ------------------------------------------------------------------------------------------------
// Remediation script identity
// ------------------------------------------------------------------------------------------------

const SCRIPT_EXTENSIONS = ['.ps1', '.sh', '.bat', '.cmd', '.txt', '.md'];

export const remediationTitle = (cycleNo: number) => `Remediation — Cycle ${cycleNo}`;

/**
 * Name and filename of the session script an accepted remediation creates: "Remediation — Cycle n",
 * `remediation-cycle-n<ext of the base script>`. A name already used in the session gets " (2)", " (3)"…
 * (and the filename "-2", "-3"…), so two accepted remediations of one cycle never look alike.
 */
export function remediationScriptIdentity(cycleNo: number, baseFilename: string, existingNames: readonly string[]): { name: string; filename: string } {
  const dot = baseFilename.lastIndexOf('.');
  const raw = dot > 0 ? baseFilename.slice(dot).toLowerCase() : '';
  const ext = SCRIPT_EXTENSIONS.includes(raw) ? raw : '.txt';
  const taken = new Set(existingNames);
  const title = remediationTitle(cycleNo);
  for (let k = 1; ; k++) {
    const name = k === 1 ? title : `${title} (${k})`;
    if (!taken.has(name)) return { name, filename: `remediation-cycle-${cycleNo}${k === 1 ? '' : `-${k}`}${ext}` };
  }
}

// ------------------------------------------------------------------------------------------------
// Verification
// ------------------------------------------------------------------------------------------------

/** A finding as verification sees it: only the CONFIRMED mapping (requirement_id) counts, never a suggestion. */
export type VerifyFinding = { status: FindingStatus; requirementId: string | null };

export type SkipReason = 'not_covered' | 'needs_review' | 'not_all_passed';
export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  not_covered: 'not covered by the current script',
  needs_review: 'potentially disruptive and not reviewed yet',
  not_all_passed: 'a finding mapped to it did not pass in this report',
};

export type VerificationPlan<R extends Requirement> = {
  /** New states (work_state 'verified', evidence_report_id = the report). */
  verified: R[];
  /** Requirements with a confirmed passing finding that cannot be verified, in requirement order. */
  skipped: { id: string; text: string; reason: SkipReason }[];
  /** Requirements with a confirmed passing finding that were already verified (left as they are). */
  alreadyVerified: number;
};

/**
 * Which requirements a report verifies. A requirement qualifies only through a confirmed finding of
 * the report with status 'pass', and only if no other confirmed finding of the report for it did not
 * pass. The moves go through the requirements state machine (transition), so the rules stay in one
 * place: proposed+covered (reviewed if disruptive) → reported → verified; reported → verified;
 * manual → verified. A verified requirement is never touched (a failing finding never downgrades it).
 */
export function planVerification<R extends Requirement>(requirements: readonly R[], findings: readonly VerifyFinding[], reportId: string): VerificationPlan<R> {
  const passed = new Set<string>();
  const notPassed = new Set<string>();
  for (const f of findings) {
    if (!f.requirementId) continue;
    (f.status === 'pass' ? passed : notPassed).add(f.requirementId);
  }
  const plan: VerificationPlan<R> = { verified: [], skipped: [], alreadyVerified: 0 };
  const evidence = { reportId };
  for (const r of requirements) {
    if (!passed.has(r.id)) continue;
    if (r.work_state === 'verified') {
      plan.alreadyVerified++;
      continue;
    }
    if (notPassed.has(r.id)) {
      plan.skipped.push({ id: r.id, text: r.text, reason: 'not_all_passed' });
      continue;
    }
    try {
      const reported = r.work_state === 'proposed' && r.coverage !== 'manual' ? transition(r, 'reported') : r;
      plan.verified.push(transition(reported, 'verified', evidence));
    } catch (e) {
      if (!(e instanceof InvalidTransitionError)) throw e;
      plan.skipped.push({ id: r.id, text: r.text, reason: /disruptive/.test(e.reason) ? 'needs_review' : 'not_covered' });
    }
  }
  return plan;
}

/** "3 requirements couldn't be verified: not covered by the current script", one line per reason (first occurrence order). */
export function skippedMessages(skipped: readonly { reason: SkipReason }[]): string[] {
  const counts = new Map<SkipReason, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => `${n} ${n === 1 ? 'requirement' : 'requirements'} couldn't be verified: ${SKIP_REASON_TEXT[reason]}`);
}

// ------------------------------------------------------------------------------------------------
// Cycle decision (the flowchart's decision node)
// ------------------------------------------------------------------------------------------------

export type CycleDecision = 'complete' | 'continue';
export type Availability = { enabled: true } | { enabled: false; reason: string };
export type DecisionAvailability = { complete: Availability; continue: Availability };

export const READ_ONLY_REASON = 'This session is completed and read-only';

/**
 * Enable rules for "Mark complete" and "Start another cycle" (the same function gates the buttons and
 * the server action). Mark complete: the current cycle's "Check final points" is Complete and
 * Verified and the cycle is not already complete. Start another cycle: the current cycle has at least
 * one LEADS report. Neither on a completed session.
 */
export function decisionAvailability(s: {
  sessionStatus: 'active' | 'completed';
  checkPoints: StepStatus;
  currentCycle: number;
  currentCycleReports: number;
  outcome: CycleOutcome | null;
}): DecisionAvailability {
  if (s.sessionStatus === 'completed') {
    const off = { enabled: false as const, reason: READ_ONLY_REASON };
    return { complete: off, continue: off };
  }
  const complete: Availability =
    s.outcome === 'completed'
      ? { enabled: false, reason: `Cycle ${s.currentCycle} is already marked complete` }
      : s.checkPoints !== 'verified'
        ? { enabled: false, reason: 'Mark “Check final points” Complete and Verified first' }
        : { enabled: true };
  const next: Availability = s.currentCycleReports > 0 ? { enabled: true } : { enabled: false, reason: `Upload a LEADS report for cycle ${s.currentCycle} first` };
  return { complete, continue: next };
}

/** The steps "Start another cycle" resets to Not Started (spec 8.3: the return loop to the LEADS audit). */
export const CYCLE_RESET_STEPS = ['run_leads', 'inspect_leads', 'run_remediation', 'check_points'] as const;
