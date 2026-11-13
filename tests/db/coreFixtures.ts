import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { sql } from './helpers';

/** Every private table created by 0002_core.sql, in an order where parents come first. */
export const CORE_TABLES = [
  'sessions',
  'scripts',
  'script_versions',
  'readmes',
  'conversations',
  'messages',
  'leads_reports',
  'requirements',
  'leads_findings',
  'proposals',
  'evidence',
  'remediation_cycles',
  'workflow_steps',
  'workflow_step_events',
  'forensic_questions',
  'activity_log',
] as const;
export type CoreTable = (typeof CORE_TABLES)[number];

/** Tables whose rows can never be updated or deleted (0003_immutability.sql). */
export const INSERT_ONLY_TABLES = ['script_versions', 'workflow_step_events', 'activity_log'] as const;

/** Child tables that become read-only once their session is completed. */
export const SESSION_CHILD_TABLES = CORE_TABLES.filter(
  (t): t is Exclude<CoreTable, 'sessions' | 'activity_log'> => t !== 'sessions' && t !== 'activity_log',
);

/** One committed row in every core table, all owned by `owner`, wired together like real data. */
export type Graph = {
  owner: string;
  sessionId: string;
  universalScriptId: string;
  universalV1: string;
  sessionScriptId: string;
  sessionV1: string;
  sessionV2: string;
  readmeId: string;
  conversationId: string;
  messageId: string;
  reportId: string;
  requirementId: string;
  findingId: string;
  proposalId: string;
  evidenceId: string;
  cycleId: string;
  stepId: string;
  stepEventId: string;
  forensicId: string;
  activityId: string;
};

export type Row = Record<string, unknown>;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

let seq = 0;
const next = () => ++seq;

/**
 * A valid NEW row for each table, owned by `g.owner` and referencing `g`'s parents.
 * Values under unique constraints are fresh on every call, so a factory row never collides with
 * the rows `buildGraph` committed.
 */
export const factories: Record<CoreTable, (g: Graph) => Row> = {
  sessions: (g) => ({ owner_id: g.owner, title: `Session ${next()}`, os: 'windows' }),
  scripts: (g) => ({
    owner_id: g.owner,
    name: `Script ${next()}`,
    filename: 'harden.ps1',
    category: 'windows',
    function: 'session_generated',
    description: 'test script',
    os_compat: '{windows,windows_server}',
    session_id: g.sessionId,
  }),
  script_versions: (g) => {
    const content = `Write-Host ${next()}`;
    return {
      owner_id: g.owner,
      script_id: g.sessionScriptId,
      version_no: 1000 + next(),
      content,
      encoding: 'utf-8-bom',
      line_ending: 'crlf',
      language: 'powershell',
      sha256: sha256(content),
      author: 'user',
      change_note: 'edit',
      base_version_id: g.sessionV1,
    };
  },
  readmes: (g) => ({
    owner_id: g.owner,
    session_id: g.sessionId,
    source: 'paste',
    text: 'Disable the guest account.',
    segments: sql.json([{ id: 'p1', kind: 'paragraph', index: 0, text: 'Disable the guest account.' }]),
    has_text_layer: true,
  }),
  conversations: (g) => ({ owner_id: g.owner, session_id: g.sessionId, mode: 'general', title: 'Chat' }),
  messages: (g) => ({
    owner_id: g.owner,
    conversation_id: g.conversationId,
    role: 'user',
    content: 'Adapt the script',
    refs: sql.json([{ type: 'readme', id: g.readmeId }]),
    status: 'complete',
    client_request_id: randomUUID(),
  }),
  leads_reports: (g) => ({
    owner_id: g.owner,
    session_id: g.sessionId,
    cycle_no: 1,
    filename: 'leads.txt',
    storage_path: `${g.owner}/${g.sessionId}/leads.txt`,
    raw_text: '[+] Guest disabled',
    parser: 'generic',
    parsed: sql.json({ parser: 'generic', score: 10, findings: [] }),
    score: 10,
  }),
  requirements: (g) => ({
    owner_id: g.owner,
    session_id: g.sessionId,
    readme_id: g.readmeId,
    text: 'Disable guest',
    segment_id: 'p1',
    coverage: 'covered',
    work_state: 'proposed',
    disruptive: false,
    automatable: true,
    script_version_id: g.sessionV1,
  }),
  leads_findings: (g) => ({
    owner_id: g.owner,
    report_id: g.reportId,
    title: 'Guest disabled',
    status: 'pass',
    severity: 'high',
    category: 'accounts',
    raw_line: 1,
    requirement_id: g.requirementId,
  }),
  proposals: (g) => ({
    owner_id: g.owner,
    conversation_id: g.conversationId,
    session_id: g.sessionId,
    kind: 'adaptation',
    base_version_id: g.sessionV1,
    proposed_content: 'Write-Host adapted',
    summary: 'Adapt for the README',
    flags: sql.json([]),
    status: 'pending',
  }),
  evidence: (g) => ({
    owner_id: g.owner,
    session_id: g.sessionId,
    step: 'run_hardening',
    kind: 'execution_output',
    storage_path: `${g.owner}/${g.sessionId}/out.txt`,
    script_version_id: g.sessionV1,
    note: 'ran it',
  }),
  remediation_cycles: (g) => ({
    owner_id: g.owner,
    session_id: g.sessionId,
    cycle_no: 1000 + next(),
    report_id: g.reportId,
    proposal_id: g.proposalId,
    outcome: 'open',
  }),
  // buildGraph commits 'open_readme'; fresh rows use another step so (session_id, step) stays unique.
  workflow_steps: (g) => ({ owner_id: g.owner, session_id: g.sessionId, step: 'run_hardening', status: 'not_started' }),
  workflow_step_events: (g) => ({
    owner_id: g.owner,
    session_id: g.sessionId,
    step: 'open_readme',
    from_status: 'not_started',
    to_status: 'in_progress',
    cycle_no: 1,
    note: 'started',
  }),
  forensic_questions: (g) => ({ owner_id: g.owner, session_id: g.sessionId, prompt: 'Who is the admin?', status: 'open' }),
  activity_log: (g) => ({
    owner_id: g.owner,
    session_id: g.sessionId,
    action: 'session.create',
    entity_type: 'session',
    entity_id: g.sessionId,
    meta: sql.json({ n: next() }),
  }),
};

/** The id column of `g` that holds the committed row of each table. */
export const graphRowId: Record<CoreTable, (g: Graph) => string> = {
  sessions: (g) => g.sessionId,
  scripts: (g) => g.sessionScriptId,
  script_versions: (g) => g.sessionV1,
  readmes: (g) => g.readmeId,
  conversations: (g) => g.conversationId,
  messages: (g) => g.messageId,
  leads_reports: (g) => g.reportId,
  requirements: (g) => g.requirementId,
  leads_findings: (g) => g.findingId,
  proposals: (g) => g.proposalId,
  evidence: (g) => g.evidenceId,
  remediation_cycles: (g) => g.cycleId,
  workflow_steps: (g) => g.stepId,
  workflow_step_events: (g) => g.stepEventId,
  forensic_questions: (g) => g.forensicId,
  activity_log: (g) => g.activityId,
};

/** A harmless column update per table, used to probe update permissions. */
export const probeUpdate: Record<CoreTable, Row> = {
  sessions: { title: 'renamed' },
  scripts: { description: 'changed' },
  script_versions: { change_note: 'changed' },
  readmes: { text: 'changed' },
  conversations: { title: 'changed' },
  messages: { content: 'changed' },
  leads_reports: { raw_text: 'changed' },
  requirements: { notes: 'changed' },
  leads_findings: { title: 'changed' },
  proposals: { summary: 'changed' },
  evidence: { note: 'changed' },
  remediation_cycles: { outcome: 'continued' },
  workflow_steps: { notes: 'changed' },
  workflow_step_events: { note: 'changed' },
  forensic_questions: { answer: 'changed', status: 'answered' },
  activity_log: { action: 'changed' },
};

/** Admin client or a transaction handle (both are tagged-template callables). */
type Db = postgres.Sql | postgres.TransactionSql;

export async function insertRow(db: Db, table: CoreTable, values: Row): Promise<string> {
  const [row] = await db`insert into ${db(table)} ${db(values)} returning id`;
  return row.id as string;
}

/**
 * Commits (as the superuser, so RLS is bypassed but every FK, check and trigger still runs) one row
 * in every core table for `owner`, wired together the way the app will wire them:
 * universal script v1 → forked session script v1 → v2 (accepted proposal result), README →
 * verified requirement backed by a LEADS report, finding mapped to the requirement, etc.
 */
export async function buildGraph(owner: string): Promise<Graph> {
  const g = { owner } as Graph;
  g.sessionId = await insertRow(sql, 'sessions', factories.sessions(g));

  g.universalScriptId = await insertRow(sql, 'scripts', {
    ...factories.scripts(g),
    session_id: null,
    function: 'universal_hardening',
  });
  g.universalV1 = await insertRow(sql, 'script_versions', {
    ...factories.script_versions(g),
    script_id: g.universalScriptId,
    version_no: 1,
    base_version_id: null,
  });
  await sql`update scripts set current_version_id = ${g.universalV1} where id = ${g.universalScriptId}`;

  g.sessionScriptId = await insertRow(sql, 'scripts', {
    ...factories.scripts(g),
    forked_from_version_id: g.universalV1,
  });
  g.sessionV1 = await insertRow(sql, 'script_versions', {
    ...factories.script_versions(g),
    version_no: 1,
    base_version_id: g.universalV1,
  });
  g.sessionV2 = await insertRow(sql, 'script_versions', {
    ...factories.script_versions(g),
    version_no: 2,
    author: 'claude',
  });
  await sql`update scripts set current_version_id = ${g.sessionV2} where id = ${g.sessionScriptId}`;

  g.readmeId = await insertRow(sql, 'readmes', factories.readmes(g));
  g.conversationId = await insertRow(sql, 'conversations', factories.conversations(g));
  g.messageId = await insertRow(sql, 'messages', factories.messages(g));
  g.reportId = await insertRow(sql, 'leads_reports', factories.leads_reports(g));
  g.requirementId = await insertRow(sql, 'requirements', {
    ...factories.requirements(g),
    work_state: 'verified',
    evidence_report_id: g.reportId,
  });
  g.findingId = await insertRow(sql, 'leads_findings', factories.leads_findings(g));
  g.proposalId = await insertRow(sql, 'proposals', {
    ...factories.proposals(g),
    status: 'accepted',
    result_version_id: g.sessionV2,
  });
  g.evidenceId = await insertRow(sql, 'evidence', factories.evidence(g));
  g.cycleId = await insertRow(sql, 'remediation_cycles', { ...factories.remediation_cycles(g), cycle_no: 1 });
  g.stepId = await insertRow(sql, 'workflow_steps', { ...factories.workflow_steps(g), step: 'open_readme' });
  g.stepEventId = await insertRow(sql, 'workflow_step_events', factories.workflow_step_events(g));
  g.forensicId = await insertRow(sql, 'forensic_questions', factories.forensic_questions(g));
  g.activityId = await insertRow(sql, 'activity_log', factories.activity_log(g));
  return g;
}

/** Marks the graph's session completed (as the superuser). */
export async function completeSession(g: Graph): Promise<void> {
  await sql`update sessions set status = 'completed', completed_at = now() where id = ${g.sessionId}`;
}

/** Resolves to the Postgres error raised by `p`; fails the test if `p` resolves. */
export async function pgError(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('expected the statement to fail, but it succeeded');
}
