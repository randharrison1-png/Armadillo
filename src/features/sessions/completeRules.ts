// Pure rules for forensic questions, evidence, points and final submission (Task 18). Client-safe.
import type { StepKey } from '@/lib/types';

export type EvidenceKind = 'execution_output' | 'screenshot' | 'verification' | 'other';
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ['execution_output', 'screenshot', 'verification', 'other'];
export const EVIDENCE_KIND_LABEL: Record<EvidenceKind, string> = {
  execution_output: 'Execution output',
  screenshot: 'Screenshot',
  verification: 'Verification',
  other: 'Other',
};

export const PROMPT_MAX = 2000;
export const ANSWER_MAX = 10000;
export const OVERRIDE_MIN = 10;
export const OVERRIDE_MAX = 500;
export const POINTS_MAX = 10000;

export const FORENSIC_OPEN_MESSAGE = 'Answer the open forensic questions or give a reason to submit anyway';
export const OVERRIDE_TOO_LONG_MESSAGE = `The reason must be ${OVERRIDE_MAX} characters or fewer`;
export const SUBMIT_EVIDENCE_MESSAGE = 'Attach verification evidence to Submit final (a screenshot or a note) before submitting';
export const EVIDENCE_EMPTY_MESSAGE = 'Attach a file or write a note';

/** Steps whose execution output (with a script version) marks the version's covered requirements Reported. */
export const EXECUTION_STEPS: readonly StepKey[] = ['run_hardening', 'run_remediation'];

/** The kind a step's evidence defaults to; the user can change it. */
export function defaultEvidenceKind(step: StepKey): EvidenceKind {
  if (step === 'run_hardening' || step === 'run_remediation') return 'execution_output';
  if (step === 'check_points' || step === 'submit_final') return 'verification';
  return 'other';
}

/** "2 of 5 answered"; "No questions yet" with none. */
export function forensicCountLabel(total: number, answered: number): string {
  return total === 0 ? 'No questions yet' : `${answered} of ${total} answered`;
}

/** "3 requirements marked Reported" (+ how many were left for review). */
export function reportedMessage(reported: number, skipped: number): string {
  const base = `${reported} ${reported === 1 ? 'requirement' : 'requirements'} marked Reported`;
  return skipped > 0 ? `${base}; ${skipped} potentially disruptive ${skipped === 1 ? 'requirement needs' : 'requirements need'} review first` : base;
}

/** A score or target: finite, 0 to 10000, at most two decimals. */
export function validPoints(n: unknown): n is number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > POINTS_MAX) return false;
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

/** The step note recorded when a session is submitted with open forensic questions. */
export const overrideLine = (reason: string) => `Submitted with open forensic questions: ${reason}`;

/** Filename kept in a storage path (`<owner>/<session>/<uuid>-<name>`), or null when there is no file. */
export function storedFilename(storagePath: string | null): string | null {
  if (!storagePath) return null;
  const name = (storagePath.split('/').pop() ?? '').slice(37);
  return name || 'file';
}

/** A forensic question as the panel shows it. */
export type ForensicItem = { id: string; prompt: string; answer: string | null; status: 'open' | 'answered'; updatedAt: string };
