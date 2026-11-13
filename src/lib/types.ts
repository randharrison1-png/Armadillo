// Shared domain types (plan §4). Later tasks rely on these names exactly.

export type OsType = 'windows' | 'windows_server' | 'linux';
export type ScriptCategory = 'windows' | 'windows_server' | 'linux' | 'leads_audit';
export type ScriptFunction = 'universal_hardening' | 'leads_audit' | 'session_generated';
export type ScriptLanguage = 'powershell' | 'bash' | 'batch' | 'text' | 'markdown';
export type TextEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be';

export type StepKey =
  | 'open_readme' | 'forensic_questions' | 'claude_adaptation' | 'run_hardening'
  | 'run_leads' | 'inspect_leads' | 'run_remediation' | 'check_points' | 'submit_final';
export type StepStatus = 'not_started' | 'in_progress' | 'verified' | 'blocked';
export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  not_started: 'Not Started', in_progress: 'In Progress',
  verified: 'Complete and Verified', blocked: 'Blocked/Needs Review',
};

export type Coverage = 'detected' | 'covered' | 'missing' | 'needs_review' | 'manual';
export type WorkState = 'proposed' | 'reported' | 'verified';   // spec §5.3 distinction

export type ResourceRef =
  { type: 'readme' | 'script_version' | 'leads_report' | 'evidence'; id: string };

export type TabKind = 'claude' | 'readme' | 'script' | 'diff' | 'flowchart' | 'report' | 'requirements';
export type TabDescriptor = { key: string; kind: TabKind; title: string; resourceId?: string };

export type HighImpactCategory = 'accounts' | 'services' | 'firewall' | 'remote_access' | 'other';
export type HighImpactFlag = {
  id: string; category: HighImpactCategory; line: number; match: string; source: 'scanner' | 'claude';
};

export type Segment = { id: string; kind: 'paragraph' | 'page'; index: number; text: string };

// Row types (Task 4): hand-written to match supabase/migrations/0002_core.sql, defined in
// src/server/db/types.ts (type-only, safe to import from client code) and re-exported here.
export type {
  Session,
  Script,
  ScriptVersion,
  Readme,
  Conversation,
  Message,
  Requirement,
  Proposal,
  LeadsReport,
  LeadsFinding,
  Evidence,
  RemediationCycle,
  WorkflowStep,
  WorkflowStepEvent,
  ForensicQuestion,
  ActivityLogEntry,
  Tables,
} from '@/server/db/types';
