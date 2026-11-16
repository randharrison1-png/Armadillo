// Client-safe data shapes for the flowchart tab.
import type { StepKey, StepStatus } from '@/lib/types';
import type { CycleOutcome, DecisionAvailability } from '@/features/reports/remediationRules';

export type FlowStep = { step: StepKey; status: StepStatus; notes: string | null; updatedAt: string };
export type FlowEvidence = {
  id: string;
  step: StepKey;
  kind: string;
  note: string | null;
  createdAt: string;
  /** The audit cycle it was attached in. */
  cycleNo: number;
  /** The stored file's name, or null for a note-only row (download: /api/files/evidence/<id>). */
  filename: string | null;
  /** "Script name · vN" of the version this output is of. */
  scriptLabel: string | null;
};
/** A script version evidence can be attached to: the session's scripts, newest first. */
export type FlowScriptVersion = { id: string; label: string };
export type FlowEvent = { id: string; step: StepKey; fromStatus: StepStatus | null; toStatus: StepStatus; cycleNo: number; note: string | null; createdAt: string };

export type FlowchartData = {
  sessionStatus: 'active' | 'completed';
  /** ISO time the session was submitted; null while active. */
  completedAt: string | null;
  currentCycle: number;
  /** Forensic question counts (the user sets the step status; nothing is automatic). */
  forensic: { total: number; answered: number };
  /** Points the user recorded for the current cycle (self-reported; not verification). */
  points: { points: number | null; target: number | null };
  scriptVersions: FlowScriptVersion[];
  steps: FlowStep[];
  evidence: FlowEvidence[];
  /** Newest first. */
  events: FlowEvent[];
  latestReport: { id: string; filename: string; cycleNo: number } | null;
  /** The session's hardening script: the newest non-archived session script that is not an accepted remediation. */
  latestSessionScript: { scriptId: string; filename: string } | null;
  /** The newest remediation proposal that was not rejected, with the script it produced once accepted. */
  latestRemediation: LatestRemediation | null;
  /** Enable rules of the decision node's "Mark complete" / "Start another cycle". */
  decision: DecisionAvailability;
  /** Recorded audit cycles, oldest first (spec 8.2: history of previous audit/remediation cycles). */
  cycles: FlowCycle[];
};

export type LatestRemediation = {
  proposalId: string;
  /** "Remediation — Cycle n" (the accepted script's name once accepted). */
  title: string;
  status: 'pending' | 'accepted';
  script: { scriptId: string; filename: string } | null;
};

export type FlowCycle = { cycleNo: number; outcome: CycleOutcome; reportFilename: string | null; updatedAt: string; points: number | null; targetPoints: number | null };

export type ActionResult<T = undefined> = ({ ok: true } & (T extends undefined ? object : { value: T })) | { ok: false; error: string };

export const NOTE_MAX = 2000;
export const EVIDENCE_REQUIRED_MESSAGE = 'Attach evidence before marking this step Complete and Verified';
export const READ_ONLY_MESSAGE = 'This session is completed and read-only';

/** Steps whose Complete and Verified needs evidence (or, for LEADS steps, a LEADS report) in the current cycle. */
export const EVIDENCE_STEPS: readonly StepKey[] = ['run_hardening', 'run_leads', 'inspect_leads', 'check_points', 'submit_final'];
/** Of those, steps a LEADS report alone satisfies. */
export const REPORT_STEPS: readonly StepKey[] = ['run_leads', 'inspect_leads'];

/** A refusal with a message that is safe to show the user. */
export class FlowchartError extends Error {}
