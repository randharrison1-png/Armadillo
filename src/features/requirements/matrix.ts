import type { Coverage, TabDescriptor, WorkState } from '@/lib/types';
import { getWorkspaceStore } from '@/features/workspace/store';
import type { RequirementRow } from './types';

/** Client-safe labels and helpers for the requirements matrix. */

export const COVERAGES: readonly Coverage[] = ['detected', 'covered', 'missing', 'needs_review', 'manual'];
/**
 * Coverage values offered in filters and counts. Assessment no longer produces 'needs_review'
 * (potentially disruptive is the sticky `disruptive` flag plus an explicit review), so it is only
 * shown when a row still has it.
 */
export const shownCoverages = (counts: Record<Coverage, number>): Coverage[] => COVERAGES.filter((c) => c !== 'needs_review' || counts[c] > 0);
export const WORK_STATES: readonly WorkState[] = ['proposed', 'reported', 'verified'];

export const COVERAGE_LABEL: Record<Coverage, string> = {
  detected: 'Detected',
  covered: 'Covered',
  missing: 'Missing',
  needs_review: 'Needs review',
  manual: 'Manual task',
};

export const COVERAGE_HINT: Record<Coverage, string> = {
  detected: 'Found in the README; not assessed against a script yet.',
  covered: 'Claude found it handled in the selected script. Pending verification.',
  missing: 'Not in the selected script; see the suggested change.',
  needs_review: 'Needs an explicit review.',
  manual: 'Not safely automatable: do it by hand.',
};

/** Spec §5.3: three distinct states. "Reported" is implemented work reported by execution output. */
export const WORK_STATE_LABEL: Record<WorkState, string> = { proposed: 'Proposed', reported: 'Reported', verified: 'Verified' };

export const WORK_STATE_HINT: Record<WorkState, string> = {
  proposed: 'Planned or assessed only. Not proof the machine is hardened.',
  reported: 'Implemented: a covering script was reported run. Not yet verified.',
  verified: 'Confirmed by verification evidence.',
};

export const CATEGORY_LABEL: Record<string, string> = {
  accounts: 'Accounts',
  passwords: 'Passwords',
  services: 'Services',
  firewall: 'Firewall',
  remote_access: 'Remote access',
  updates: 'Updates',
  software: 'Software',
  files: 'Files',
  policies: 'Policies',
  auditing: 'Auditing',
  forensics: 'Forensics',
  other: 'Other',
};

/** "¶ 3" for the third paragraph (indexes are 0-based), "Page 3" for PDF page 3 (1-based). */
export function sourceLabel(kind: RequirementRow['sourceKind'], index: number | null): string {
  if (kind === 'page' && index !== null) return `Page ${index}`;
  if (kind === 'paragraph' && index !== null) return `¶ ${index + 1}`;
  return 'Unknown section';
}

export type MatrixFilters = { coverage: Coverage | 'all'; state: WorkState | 'all' };

export function filterRows(rows: readonly RequirementRow[], f: MatrixFilters): RequirementRow[] {
  return rows.filter((r) => (f.coverage === 'all' || r.coverage === f.coverage) && (f.state === 'all' || r.workState === f.state));
}

/** Potentially disruptive and not yet explicitly reviewed: shows the "Needs review" marker, cannot be reported. */
export const needsReview = (r: Pick<RequirementRow, 'disruptive' | 'reviewedAt'>): boolean => r.disruptive && !r.reviewedAt;

export function countRows(rows: readonly RequirementRow[]) {
  const coverage = Object.fromEntries(COVERAGES.map((c) => [c, 0])) as Record<Coverage, number>;
  const state = Object.fromEntries(WORK_STATES.map((s) => [s, 0])) as Record<WorkState, number>;
  let review = 0;
  for (const r of rows) {
    coverage[r.coverage]++;
    state[r.workState]++;
    if (needsReview(r)) review++;
  }
  return { total: rows.length, coverage, state, needsReview: review };
}

/** A row may show "Verified" only together with its evidence report (audit accuracy). */
export function isShownVerified(r: Pick<RequirementRow, 'workState' | 'evidenceReportId'>): boolean {
  return r.workState === 'verified' && !!r.evidenceReportId;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function droppedMessage(n: number): string | null {
  if (n <= 0) return null;
  return `${n} ${plural(n, 'item was', 'items were')} dropped because ${plural(n, 'it', 'they')} didn't cite a README section`;
}

export const REQUIREMENTS_TAB: TabDescriptor = { key: 'requirements', kind: 'requirements', title: 'Requirements' };

/** Opens (or focuses) the session's requirements matrix tab. Client-side only. */
export function openRequirements(sessionId: string): void {
  getWorkspaceStore(sessionId).getState().openTab({ ...REQUIREMENTS_TAB });
}
