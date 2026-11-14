import { afterAll, describe, expect, it } from 'vitest';
import { sql } from './helpers';
import type {
  Coverage,
  OsType,
  ScriptCategory,
  ScriptFunction,
  ScriptLanguage,
  StepKey,
  StepStatus,
  TextEncoding,
  WorkState,
} from '@/lib/types';
import type { TableRows } from '@/server/db/types';

afterAll(async () => {
  await sql.end();
});

/**
 * `Record<keyof Row, true>` makes the compiler demand every property of the hand-written row type and
 * reject any extra one, so this object is a checked copy of src/server/db/types.ts. The test then
 * compares it with the live columns, so types.ts and 0002_core.sql cannot drift apart.
 */
type ColumnSet = { [K in keyof TableRows]: Record<keyof TableRows[K], true> };
const t = true as const;
const COLUMNS: ColumnSet = {
  sessions: { id: t, owner_id: t, created_at: t, updated_at: t, title: t, os: t, status: t, current_cycle: t, completed_at: t },
  scripts: {
    id: t, owner_id: t, created_at: t, updated_at: t, name: t, filename: t, category: t, function: t, description: t,
    os_compat: t, session_id: t, forked_from_version_id: t, current_version_id: t, archived_at: t,
  },
  script_versions: {
    id: t, owner_id: t, created_at: t, script_id: t, version_no: t, content: t, encoding: t, line_ending: t, language: t,
    sha256: t, author: t, change_note: t, base_version_id: t,
  },
  readmes: {
    id: t, owner_id: t, created_at: t, updated_at: t, session_id: t, source: t, filename: t, storage_path: t, text: t,
    segments: t, has_text_layer: t,
  },
  conversations: { id: t, owner_id: t, created_at: t, updated_at: t, session_id: t, mode: t, title: t },
  messages: {
    id: t, owner_id: t, created_at: t, updated_at: t, conversation_id: t, role: t, content: t, refs: t, status: t,
    client_request_id: t, model: t, usage: t,
  },
  requirements: {
    id: t, owner_id: t, created_at: t, updated_at: t, session_id: t, readme_id: t, text: t, segment_id: t, coverage: t,
    work_state: t, disruptive: t, automatable: t, script_version_id: t, evidence_report_id: t, notes: t, category: t,
    suggestion: t,
  },
  proposals: {
    id: t, owner_id: t, created_at: t, updated_at: t, conversation_id: t, session_id: t, kind: t, base_version_id: t,
    proposed_content: t, summary: t, flags: t, status: t, result_version_id: t,
  },
  leads_reports: {
    id: t, owner_id: t, created_at: t, updated_at: t, session_id: t, cycle_no: t, filename: t, storage_path: t,
    raw_text: t, parser: t, parsed: t, score: t,
  },
  leads_findings: {
    id: t, owner_id: t, created_at: t, updated_at: t, report_id: t, title: t, status: t, severity: t, category: t,
    raw_line: t, requirement_id: t,
  },
  evidence: {
    id: t, owner_id: t, created_at: t, updated_at: t, session_id: t, step: t, kind: t, storage_path: t,
    script_version_id: t, note: t,
  },
  remediation_cycles: {
    id: t, owner_id: t, created_at: t, updated_at: t, session_id: t, cycle_no: t, report_id: t, proposal_id: t, outcome: t,
  },
  workflow_steps: { id: t, owner_id: t, created_at: t, updated_at: t, session_id: t, step: t, status: t, notes: t },
  workflow_step_events: {
    id: t, owner_id: t, created_at: t, session_id: t, step: t, from_status: t, to_status: t, cycle_no: t, note: t,
  },
  forensic_questions: { id: t, owner_id: t, created_at: t, updated_at: t, session_id: t, prompt: t, answer: t, status: t },
  activity_log: { id: t, owner_id: t, created_at: t, session_id: t, action: t, entity_type: t, entity_id: t, meta: t },
};

/** Same trick for the enums: every member of the TS union, and nothing else. */
const ENUMS: Record<string, Record<string, true>> = {
  os_type: { windows: t, windows_server: t, linux: t } satisfies Record<OsType, true>,
  script_category: { windows: t, windows_server: t, linux: t, leads_audit: t } satisfies Record<ScriptCategory, true>,
  script_function: { universal_hardening: t, leads_audit: t, session_generated: t } satisfies Record<ScriptFunction, true>,
  script_language: { powershell: t, bash: t, batch: t, text: t, markdown: t } satisfies Record<ScriptLanguage, true>,
  text_encoding: { 'utf-8': t, 'utf-8-bom': t, 'utf-16le': t, 'utf-16be': t, 'windows-1252': t } satisfies Record<TextEncoding, true>,
  step_key: {
    open_readme: t, forensic_questions: t, claude_adaptation: t, run_hardening: t, run_leads: t, inspect_leads: t,
    run_remediation: t, check_points: t, submit_final: t,
  } satisfies Record<StepKey, true>,
  step_status: { not_started: t, in_progress: t, verified: t, blocked: t } satisfies Record<StepStatus, true>,
  coverage: { detected: t, covered: t, missing: t, needs_review: t, manual: t } satisfies Record<Coverage, true>,
  work_state: { proposed: t, reported: t, verified: t } satisfies Record<WorkState, true>,
};

describe('src/server/db/types.ts matches the schema', () => {
  for (const [table, columns] of Object.entries(COLUMNS)) {
    it(`${table} columns`, async () => {
      const rows = await sql`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = ${table}`;
      expect(rows.map((r) => r.column_name).sort()).toEqual(Object.keys(columns).sort());
    });
  }

  for (const [name, members] of Object.entries(ENUMS)) {
    it(`enum ${name} matches its TypeScript union`, async () => {
      const rows = await sql`
        select e.enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid
        join pg_namespace n on n.oid = ty.typnamespace
        where n.nspname = 'public' and ty.typname = ${name} order by e.enumsortorder`;
      expect(rows.map((r) => r.enumlabel).sort()).toEqual(Object.keys(members).sort());
    });
  }
});
