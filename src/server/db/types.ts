// Hand-written row types for the core tables (supabase/migrations/0002_core.sql).
//
// Naming: property names are the column names, snake_case, exactly as postgres.js returns rows
// (the pool in ./pool.ts has no case transform). Value types follow postgres.js defaults:
// uuid/text → string, integer → number, numeric → string (exact decimal), timestamptz → Date,
// jsonb → parsed JSON, enum[] → string[].
//
// Writing jsonb with postgres.js: pass `tx.json(value)`, not JSON.stringify(value) — a string
// parameter is stored as a JSON *string*; the jsonb shape checks in 0002 reject that.
//
// Type-only module (no runtime code, no 'server-only'): client components may import these via
// '@/lib/types'.

import type {
  Coverage,
  HighImpactFlag,
  OsType,
  ResourceRef,
  ScriptCategory,
  ScriptFunction,
  ScriptLanguage,
  Segment,
  StepKey,
  StepStatus,
  TextEncoding,
  WorkState,
} from '@/lib/types';

export type LineEnding = 'crlf' | 'lf' | 'mixed';
export type SessionStatus = 'active' | 'completed';
export type ScriptAuthor = 'user' | 'claude';
export type ReadmeSource = 'paste' | 'upload';
export type ConversationMode = 'adaptation' | 'remediation' | 'general';
export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'streaming' | 'complete' | 'error';
export type ProposalKind = 'adaptation' | 'remediation';
export type ProposalStatus = 'pending' | 'accepted' | 'rejected';
export type FindingStatus = 'pass' | 'fail' | 'unknown';
export type EvidenceKind = 'execution_output' | 'screenshot' | 'verification' | 'other';
export type CycleOutcome = 'open' | 'completed' | 'continued';
export type ForensicStatus = 'open' | 'answered';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Columns every core table has. `owner_id` defaults to auth.uid() on insert. */
type Owned = { id: string; owner_id: string; created_at: Date };
/** Mutable tables also carry updated_at (maintained by a trigger). */
type Mutable = Owned & { updated_at: Date };

/** sessions — read-only children once status = 'completed'. */
export type Session = Mutable & {
  title: string;
  os: OsType;
  status: SessionStatus;
  current_cycle: number;
  /** Set exactly when status = 'completed' (check constraint). */
  completed_at: Date | null;
};

/** scripts — session_id null ⇒ universal library script. Universal scripts are archived, never deleted. */
export type Script = Mutable & {
  name: string;
  filename: string;
  category: ScriptCategory;
  function: ScriptFunction;
  description: string | null;
  os_compat: OsType[];
  session_id: string | null;
  forked_from_version_id: string | null;
  /** Must be a version of this script; null only until the first version is inserted. */
  current_version_id: string | null;
  archived_at: Date | null;
};

/** script_versions — INSERT-ONLY. Unique (script_id, version_no). */
export type ScriptVersion = Owned & {
  script_id: string;
  version_no: number;
  content: string;
  encoding: TextEncoding;
  line_ending: LineEnding;
  language: ScriptLanguage;
  /** Lowercase hex SHA-256. */
  sha256: string;
  author: ScriptAuthor;
  change_note: string | null;
  base_version_id: string | null;
};

export type Readme = Mutable & {
  session_id: string;
  source: ReadmeSource;
  filename: string | null;
  storage_path: string | null;
  text: string;
  segments: Segment[];
  has_text_layer: boolean;
};

export type Conversation = Mutable & {
  session_id: string;
  mode: ConversationMode;
  title: string | null;
};

/** messages — client_request_id is unique per conversation (null allowed). */
export type Message = Mutable & {
  conversation_id: string;
  role: MessageRole;
  content: string;
  refs: ResourceRef[];
  status: MessageStatus;
  client_request_id: string | null;
  model: string | null;
  usage: Json | null;
};

/** requirements — work_state 'verified' requires evidence_report_id (check constraint). */
export type Requirement = Mutable & {
  session_id: string;
  readme_id: string;
  text: string;
  segment_id: string;
  coverage: Coverage;
  work_state: WorkState;
  disruptive: boolean;
  automatable: boolean;
  script_version_id: string | null;
  evidence_report_id: string | null;
  /** The user's own notes. */
  notes: string | null;
  /** Claude's classification at extraction (0004b). */
  category: string | null;
  /** Claude's suggested change from the last coverage assessment (0004b). */
  suggestion: string | null;
  /** When the user explicitly reviewed this (disruptive) requirement (0004b). */
  reviewed_at: Date | null;
};

/** proposals — status 'accepted' requires result_version_id. */
export type Proposal = Mutable & {
  conversation_id: string | null;
  session_id: string;
  kind: ProposalKind;
  base_version_id: string | null;
  proposed_content: string;
  summary: string;
  flags: HighImpactFlag[];
  status: ProposalStatus;
  result_version_id: string | null;
  /** The README an adaptation was written for (0004c); null for remediation proposals. */
  readme_id: string | null;
};

export type LeadsReport = Mutable & {
  session_id: string;
  cycle_no: number;
  filename: string;
  storage_path: string | null;
  raw_text: string;
  parser: string;
  /** ParsedReport (Task 16). */
  parsed: { [key: string]: Json };
  /** numeric → string (exact); parse with Number() for display. */
  score: string | null;
};

export type LeadsFinding = Mutable & {
  report_id: string;
  title: string;
  status: FindingStatus;
  severity: string | null;
  category: string | null;
  raw_line: number;
  requirement_id: string | null;
};

export type Evidence = Mutable & {
  session_id: string;
  step: StepKey;
  kind: EvidenceKind;
  storage_path: string | null;
  script_version_id: string | null;
  note: string | null;
};

/** remediation_cycles — unique (session_id, cycle_no). */
export type RemediationCycle = Mutable & {
  session_id: string;
  cycle_no: number;
  report_id: string | null;
  proposal_id: string | null;
  outcome: CycleOutcome;
};

/** workflow_steps — unique (session_id, step); 9 rows per session. */
export type WorkflowStep = Mutable & {
  session_id: string;
  step: StepKey;
  status: StepStatus;
  notes: string | null;
};

/** workflow_step_events — INSERT-ONLY history. */
export type WorkflowStepEvent = Owned & {
  session_id: string;
  step: StepKey;
  from_status: StepStatus | null;
  to_status: StepStatus;
  cycle_no: number;
  note: string | null;
};

/** forensic_questions — status 'answered' requires answer. */
export type ForensicQuestion = Mutable & {
  session_id: string;
  prompt: string;
  answer: string | null;
  status: ForensicStatus;
};

/** activity_log — INSERT-ONLY. Writable even in completed sessions. */
export type ActivityLogEntry = Owned & {
  session_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  meta: { [key: string]: Json };
};

/** Table name → row type. `Tables<'sessions'>` is `Session`. */
export type TableRows = {
  sessions: Session;
  scripts: Script;
  script_versions: ScriptVersion;
  readmes: Readme;
  conversations: Conversation;
  messages: Message;
  requirements: Requirement;
  proposals: Proposal;
  leads_reports: LeadsReport;
  leads_findings: LeadsFinding;
  evidence: Evidence;
  remediation_cycles: RemediationCycle;
  workflow_steps: WorkflowStep;
  workflow_step_events: WorkflowStepEvent;
  forensic_questions: ForensicQuestion;
  activity_log: ActivityLogEntry;
};
export type Tables<T extends keyof TableRows> = TableRows[T];
