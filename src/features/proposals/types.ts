// Client-safe shapes for proposal review (no runtime code).
import type { HighImpactFlag, Proposal, Script, ScriptVersion } from '@/lib/types';

/** Everything the proposal diff tab shows. */
export type ProposalView = {
  proposal: Proposal;
  /** The version the proposal edits (a remediation: the hardening script it was written against), with its script. */
  base: { script: Script; version: ScriptVersion } | null;
  /** The base script's current version now (differs from `base.version` once someone saved since). */
  latestBaseVersion: { id: string; version_no: number } | null;
  /** e.g. "Nov 14, 2026, 9:30 AM UTC · pasted"; null when the README is gone or none was used. */
  readmeLabel: string | null;
  sessionStatus: 'active' | 'completed';
  /** Accepted, rejected, or the session is completed: nothing can be changed. */
  readOnly: boolean;
  /** The version an accepted proposal produced. */
  result: { versionId: string; versionNo: number; scriptId: string; scriptName: string; filename: string; content: string } | null;
  /** Remediation proposals: the audit cycle and report it answers; accepting creates the script `title`. Null for adaptations. */
  remediation: { cycleNo: number; title: string; reportId: string | null; reportFilename: string | null } | null;
};

export type ReadmeChoice = { id: string; label: string; hasText: boolean };

/** For "Propose adaptation" buttons outside the requirements matrix. */
export type AdaptationOptions = { active: boolean; readmes: ReadmeChoice[] };

export type ActionError = { ok: false; error: string };

export type ProposeOutcome = {
  ok: true;
  proposalId: string;
  /** Script filename (for the tab title). */
  filename: string;
  flags: number;
  /** Claude flags pointing at lines that do not exist (dropped). */
  droppedFlags: number;
  /** The README was shortened to fit Claude's context. */
  readmeTrimmed: boolean;
};

export type AcceptOutcome = {
  ok: true;
  versionId: string;
  versionNo: number;
  scriptId: string;
  scriptName: string;
  filename: string;
  /** The base was a universal script: a session copy was created first. */
  forked: boolean;
  /** The accepted text equals the version it was saved on (no new version). */
  unchanged: boolean;
};

export type AcceptFailure =
  | ActionError
  | (ActionError & { missingFlagIds: string[]; missingFlags: HighImpactFlag[] })
  | (ActionError & { conflict: { latestVersionId: string; latestVersionNo: number } });

export type RejectOutcome = { ok: true };

export type { Proposal, ScriptVersion };
