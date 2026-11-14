import 'server-only';
import { logActivity } from '@/server/activity';
import { requireUser } from '@/server/auth';
import { withUser, type Tx } from '@/server/db/withUser';
import { callClaudeTool, ClaudeUpstreamError, ContextTooLargeError, StructuredOutputError, type ClaudeToolResult } from '@/server/claude/client';
import { ForbiddenError } from '@/server/claude/context';
import type { DataBlock } from '@/server/claude/documents';
import {
  mappingData,
  mappingInstruction,
  MAX_MAPPING_FINDINGS,
  MAX_PROMPT_REQUIREMENTS,
  remediationFindingsData,
  remediationInstruction,
  remediationRequirementsData,
} from '@/server/claude/prompts/remediation';
import { MAP_TOOL, MappingSchema, REMEDIATE_TOOL, RemediationSchema, type Mapping, type Remediation } from '@/server/claude/schemas';
import { mergeFlags, resolveClaudeFlags, scanHighImpact } from '@/server/security/highImpact';
import { MAX_TEXT_BYTES } from '@/server/files/limits';
import { setStepStatusTx } from '@/features/flowchart/steps';
import { normalizeForLineEnding } from '@/features/library/versioning';
import { unfence } from '@/features/proposals/service';
import type { Coverage, Proposal, Requirement, StepStatus, WorkState } from '@/lib/types';
import { planVerification, remediableFindings, remediationTitle, skippedMessages, type FindingStatus, type SkipReason } from './remediationRules';
import { isUuid, NotFoundError, SessionReadOnlyError } from './service';
import { latestHardeningScriptTx } from './sessionScripts';

/**
 * Targeted remediation (spec §5.2, Task 17):
 *  - proposeRemediation: after a LEADS report, Claude writes a short follow-up script for the
 *    report's failing findings only (not a rerun of the hardening script). It is stored as a pending
 *    proposal (kind 'remediation') against the session's current hardening script, reviewed in the
 *    diff tab like an adaptation, and on accept becomes a NEW session script "Remediation — Cycle n"
 *    (proposals/service.ts, ruling R6).
 *  - mapFindingsToRequirements: Claude SUGGESTS which requirement each finding checks; nothing
 *    counts until the user confirms a suggestion (requirement_id) in the report tab.
 *  - applyVerification: confirmed passing findings are verification evidence: their requirements
 *    move to verified (through the requirements state machine) with evidence_report_id = the report.
 *
 * Lock order (app-wide, see flowchart/steps.ts): the sessions row first (FOR NO KEY UPDATE), then
 * workflow_steps rows, then child rows. Claude is called outside any transaction; results are written
 * afterwards with their activity entry (ids and counts, never report or script content).
 */

export { NotFoundError, SessionReadOnlyError };

/** The request cannot be carried out as asked. Message is user-facing. */
export class RemediationInputError extends Error {
  readonly name = 'RemediationInputError';
}

export const NO_HARDENING_SCRIPT_MESSAGE =
  'This session has no hardening script yet. Accept an adaptation (or fork a library script into the session) first: a remediation is written against the script already run on the machine.';
const ALL_PASSED_MESSAGE = 'Every finding in this report passed, so there is nothing to remediate.';

const isReadOnlyError = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '55000';

async function writing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isReadOnlyError(e)) throw new SessionReadOnlyError();
    throw e;
  }
}

async function logFailedRun(userId: string, e: unknown, entry: { action: string; entityId: string; sessionId: string }) {
  const code =
    e instanceof StructuredOutputError || e instanceof ClaudeUpstreamError || e instanceof ContextTooLargeError
      ? e.code
      : e instanceof ForbiddenError
        ? 'forbidden'
        : ((e as { code?: unknown })?.code ?? 'error');
  try {
    await withUser(userId, (tx) => logActivity(tx, { action: entry.action, entityType: 'leads_report', entityId: entry.entityId, sessionId: entry.sessionId, meta: { code: String(code) } }));
  } catch {
    // logging must not hide why the run failed
  }
}

type ReportContext = { id: string; session_id: string; filename: string; cycle_no: number; parser: string; session_status: 'active' | 'completed'; current_cycle: number };

/** The report with its session's state (RLS: only the user's own). Null when missing or not the user's. */
async function reportContext(tx: Tx, reportId: string): Promise<ReportContext | null> {
  if (!isUuid(reportId)) return null;
  const [r] = await tx<ReportContext[]>`
    select r.id, r.session_id, r.filename, r.cycle_no, r.parser, s.status as session_status, s.current_cycle
    from public.leads_reports r join public.sessions s on s.id = r.session_id where r.id = ${reportId}`;
  return r ?? null;
}

/** Locks the session row (lock order: first) and refuses a completed session. */
async function lockActiveSession(tx: Tx, sessionId: string): Promise<{ current_cycle: number }> {
  const [s] = await tx<{ status: 'active' | 'completed'; current_cycle: number }[]>`
    select status, current_cycle from public.sessions where id = ${sessionId} for no key update`;
  if (!s) throw new NotFoundError();
  if (s.status === 'completed') throw new SessionReadOnlyError();
  return s;
}

type FindingRow = { id: string; title: string; status: FindingStatus; severity: string | null; category: string | null; raw_line: number };

const findingsInReportOrder = (tx: Tx, reportId: string, limit: number) => tx<FindingRow[]>`
  select id, title, status, severity, category, raw_line from public.leads_findings
  where report_id = ${reportId} order by (raw_line = 0), raw_line, created_at, id limit ${limit}`;

// ------------------------------------------------------------------------------------------------
// Propose
// ------------------------------------------------------------------------------------------------

export type ProposeRemediationResult = {
  proposal: Proposal;
  /** "Remediation — Cycle n" (the name the script gets on accept; also the diff tab title). */
  title: string;
  cycleNo: number;
  /** Failing/unknown findings sent to Claude. */
  findings: number;
  /** Claude flags pointing at lines that do not exist (dropped). */
  droppedFlags: number;
};

/**
 * Asks Claude for a targeted remediation of one LEADS report of the session and stores it as a
 * pending 'remediation' proposal whose base is the session's current hardening script version.
 * Claude sees: the report (document), that script version (document, context only), and as
 * untrusted data the report's failing and unknown findings (never the passing ones) and the
 * session's requirements (text, coverage, state).
 *
 * In one transaction afterwards (session lock first): run_remediation Not Started → In Progress,
 * the proposal, the current cycle's remediation_cycles row upserted (report, proposal, 'open'),
 * the activity entry.
 *
 * Throws NotFoundError, SessionReadOnlyError, RemediationInputError (no hardening script; every
 * finding passed), and the gateway's errors.
 */
export async function proposeRemediationFor(userId: string, input: { sessionId: string; reportId: string }): Promise<ProposeRemediationResult> {
  const sessionId = String(input.sessionId);
  const reportId = String(input.reportId);
  if (!isUuid(sessionId)) throw new NotFoundError();
  if (!isUuid(reportId)) throw new NotFoundError('Report');

  const pre = await withUser(userId, async (tx) => {
    const report = await reportContext(tx, reportId);
    if (!report || report.session_id !== sessionId) throw new NotFoundError('Report');
    if (report.session_status === 'completed') throw new SessionReadOnlyError();
    const base = await latestHardeningScriptTx(tx, sessionId);
    if (!base) throw new RemediationInputError(NO_HARDENING_SCRIPT_MESSAGE);
    const findings = await findingsInReportOrder(tx, reportId, 100_000);
    const failing = remediableFindings(findings);
    if (findings.length > 0 && failing.length === 0) throw new RemediationInputError(ALL_PASSED_MESSAGE);
    const requirements = await tx<{ text: string; coverage: Coverage; work_state: WorkState }[]>`
      select text, coverage, work_state from public.requirements where session_id = ${sessionId}
      order by created_at, id limit ${MAX_PROMPT_REQUIREMENTS}`;
    return { report, base, failing, unparsed: findings.length === 0, requirements };
  });

  const { base } = pre;
  const data: DataBlock[] = [];
  if (pre.failing.length) {
    data.push(remediationFindingsData(pre.failing.map((f) => ({ title: f.title, status: f.status, severity: f.severity, category: f.category, rawLine: f.raw_line > 0 ? f.raw_line : null }))));
  }
  if (pre.requirements.length) data.push(remediationRequirementsData(pre.requirements.map((r) => ({ text: r.text, coverage: r.coverage, workState: r.work_state }))));

  const failure = { action: 'proposal.remediate.failed', entityId: reportId, sessionId };
  let result: ClaudeToolResult<Remediation>;
  try {
    result = await callClaudeTool({
      userId,
      sessionId,
      refs: [
        { type: 'leads_report', id: reportId },
        { type: 'script_version', id: base.version.id },
      ],
      data,
      instruction: () =>
        remediationInstruction({
          language: base.version.language,
          filename: base.script.filename,
          findings: pre.failing.length,
          hasRequirements: pre.requirements.length > 0,
          unparsed: pre.unparsed,
        }),
      tool: REMEDIATE_TOOL,
      schema: RemediationSchema,
    });
  } catch (e) {
    await logFailedRun(userId, e, failure);
    throw e;
  }

  const content = normalizeForLineEnding(unfence(result.data.content, base.version.language), base.version.line_ending);
  if (new TextEncoder().encode(content).length > MAX_TEXT_BYTES) {
    const e = new StructuredOutputError('Remediation script exceeds 2 MB.');
    await logFailedRun(userId, e, failure);
    throw e;
  }
  const scanner = scanHighImpact(content, base.version.language);
  const { flags: claude, dropped } = resolveClaudeFlags(result.data.flags, content);
  const flags = mergeFlags(scanner, claude);

  return writing(() =>
    withUser(userId, async (tx) => {
      const session = await lockActiveSession(tx, sessionId);
      const [step] = await tx<{ status: StepStatus }[]>`
        select status from public.workflow_steps where session_id = ${sessionId} and step = 'run_remediation' for update`;
      if (step?.status === 'not_started') await setStepStatusTx(tx, { sessionId, step: 'run_remediation', status: 'in_progress' });

      const [proposal] = await tx<Proposal[]>`
        insert into public.proposals (session_id, kind, base_version_id, readme_id, proposed_content, summary, flags)
        values (${sessionId}, 'remediation', ${base.version.id}, null, ${content}, ${result.data.summary}, ${tx.json(flags as never)})
        returning *`;
      await tx`
        insert into public.remediation_cycles (session_id, cycle_no, report_id, proposal_id, outcome)
        values (${sessionId}, ${session.current_cycle}, ${reportId}, ${proposal!.id}, 'open')
        on conflict (session_id, cycle_no) do update
          set report_id = excluded.report_id, proposal_id = excluded.proposal_id, outcome = 'open'`;
      await logActivity(tx, {
        action: 'proposal.create',
        entityType: 'proposal',
        entityId: proposal!.id,
        sessionId,
        meta: {
          kind: 'remediation',
          reportId,
          cycle: session.current_cycle,
          baseVersionId: base.version.id,
          scriptId: base.script.id,
          findings: pre.failing.length,
          unparsed: pre.unparsed,
          flags: flags.length,
          scannerFlags: scanner.length,
          claudeFlags: claude.length,
          droppedFlags: dropped,
          trimmed: result.trimmed.length,
          model: result.model,
          attempts: result.attempts,
        },
      });
      return { proposal: proposal!, title: remediationTitle(session.current_cycle), cycleNo: session.current_cycle, findings: pre.failing.length, droppedFlags: dropped };
    }),
  );
}

// ------------------------------------------------------------------------------------------------
// Finding → requirement mapping
// ------------------------------------------------------------------------------------------------

export type MappingResult = {
  /** Every finding sent to Claude (report order) with the requirement Claude suggested (null: none). */
  mappings: { findingId: string; requirementId: string | null }[];
  suggested: number;
  /** Items naming an unknown or repeated finding, or an unknown requirement. */
  dropped: number;
};

/** Claude's keyed answer → suggestions. Unknown keys and repeated findings are dropped and counted. */
export function resolveMappings(items: Mapping['mappings'], findings: Map<string, string>, requirements: Map<string, string>) {
  const out = new Map<string, string | null>();
  let dropped = 0;
  for (const m of items) {
    const findingId = findings.get(m.finding);
    if (!findingId || out.has(findingId)) {
      dropped++;
      continue;
    }
    if (m.requirement === null) {
      out.set(findingId, null);
      continue;
    }
    const requirementId = requirements.get(m.requirement);
    if (!requirementId) dropped++;
    out.set(findingId, requirementId ?? null);
  }
  return { suggestions: out, dropped };
}

/**
 * Claude suggests, for each finding of the report (all statuses, report order, up to 500), the
 * session requirement it checks. Stored in leads_findings.suggested_requirement_id only (every id is
 * one of the session's requirements, which the database checks again); confirmed mappings
 * (requirement_id) are never touched. Findings and requirements go to Claude as untrusted data only.
 */
export async function mapFindingsToRequirementsFor(userId: string, reportId: string): Promise<MappingResult> {
  const id = String(reportId);
  const pre = await withUser(userId, async (tx) => {
    const report = await reportContext(tx, id);
    if (!report) throw new NotFoundError('Report');
    if (report.session_status === 'completed') throw new SessionReadOnlyError();
    const findings = await findingsInReportOrder(tx, id, MAX_MAPPING_FINDINGS);
    if (findings.length === 0) throw new RemediationInputError('No findings could be parsed from this report, so there is nothing to map.');
    const requirements = await tx<{ id: string; text: string }[]>`
      select id, text from public.requirements where session_id = ${report.session_id} order by created_at, id limit ${MAX_PROMPT_REQUIREMENTS}`;
    if (requirements.length === 0) throw new RemediationInputError('This session has no requirements yet. Extract requirements from the README first.');
    return { report, findings, requirements };
  });

  const fKeys = new Map(pre.findings.map((f, i) => [`F${i + 1}`, f.id]));
  const rKeys = new Map(pre.requirements.map((r, i) => [`R${i + 1}`, r.id]));
  const sessionId = pre.report.session_id;
  let result: ClaudeToolResult<Mapping>;
  try {
    result = await callClaudeTool({
      userId,
      sessionId,
      refs: [],
      data: mappingData(pre.findings, pre.requirements),
      instruction: () => mappingInstruction([...fKeys.keys()], [...rKeys.keys()]),
      tool: MAP_TOOL,
      schema: MappingSchema,
    });
  } catch (e) {
    await logFailedRun(userId, e, { action: 'leads_findings.suggest.failed', entityId: id, sessionId });
    throw e;
  }

  const { suggestions, dropped } = resolveMappings(result.data.mappings, fKeys, rKeys);
  const mappings = pre.findings.map((f) => ({ findingId: f.id, requirementId: suggestions.get(f.id) ?? null }));
  const suggested = mappings.filter((m) => m.requirementId).length;
  return writing(() =>
    withUser(userId, async (tx) => {
      await lockActiveSession(tx, sessionId);
      await tx`
        update public.leads_findings f set suggested_requirement_id = u.req
        from jsonb_to_recordset(${tx.json(mappings.map((m) => ({ id: m.findingId, req: m.requirementId })) as never)}) as u(id uuid, req uuid)
        where f.id = u.id and f.report_id = ${id}
          and (u.req is null or exists (select 1 from public.requirements q where q.id = u.req and q.session_id = ${sessionId}))`;
      await logActivity(tx, {
        action: 'leads_findings.suggest',
        entityType: 'leads_report',
        entityId: id,
        sessionId,
        meta: { findings: mappings.length, suggested, dropped, model: result.model, attempts: result.attempts },
      });
      return { mappings, suggested, dropped };
    }),
  );
}

type FindingContext = { id: string; report_id: string; suggested_requirement_id: string | null; requirement_id: string | null; session_id: string };

/**
 * The user's decision for one finding: Confirm (the suggestion) or Change (another requirement)
 * writes requirement_id; Clear (null) removes both the mapping and the suggestion. The requirement
 * must belong to the finding's session. Logged.
 */
export async function setFindingRequirementFor(userId: string, input: { findingId: string; requirementId: string | null }): Promise<{ requirementId: string | null }> {
  const findingId = String(input.findingId);
  const requirementId = input.requirementId === null ? null : String(input.requirementId);
  if (!isUuid(findingId)) throw new NotFoundError('Finding');
  if (requirementId !== null && !isUuid(requirementId)) throw new NotFoundError('Requirement');
  return writing(() =>
    withUser(userId, async (tx) => {
      const [f] = await tx<FindingContext[]>`
        select f.id, f.report_id, f.suggested_requirement_id, f.requirement_id, r.session_id
        from public.leads_findings f join public.leads_reports r on r.id = f.report_id where f.id = ${findingId}`;
      if (!f) throw new NotFoundError('Finding');
      await lockActiveSession(tx, f.session_id);
      if (requirementId !== null) {
        const [q] = await tx`select 1 from public.requirements where id = ${requirementId} and session_id = ${f.session_id}`;
        if (!q) throw new NotFoundError('Requirement');
      }
      await tx`
        update public.leads_findings
        set requirement_id = ${requirementId}, suggested_requirement_id = ${requirementId === null ? null : f.suggested_requirement_id}
        where id = ${findingId}`;
      await logActivity(tx, {
        action: 'leads_finding.map',
        entityType: 'leads_finding',
        entityId: findingId,
        sessionId: f.session_id,
        meta: {
          reportId: f.report_id,
          requirementId,
          change: requirementId === null ? 'clear' : requirementId === f.suggested_requirement_id ? 'confirm' : 'change',
        },
      });
      return { requirementId };
    }),
  );
}

/** "Confirm all suggestions": every finding of the report with a suggestion and no mapping yet takes its suggestion. */
export async function confirmAllSuggestionsFor(userId: string, reportId: string): Promise<{ confirmed: number }> {
  const id = String(reportId);
  return writing(() =>
    withUser(userId, async (tx) => {
      const report = await reportContext(tx, id);
      if (!report) throw new NotFoundError('Report');
      await lockActiveSession(tx, report.session_id);
      const rows = await tx`
        update public.leads_findings set requirement_id = suggested_requirement_id
        where report_id = ${id} and requirement_id is null and suggested_requirement_id is not null
        returning id`;
      await logActivity(tx, { action: 'leads_findings.confirm_all', entityType: 'leads_report', entityId: id, sessionId: report.session_id, meta: { confirmed: rows.length } });
      return { confirmed: rows.length };
    }),
  );
}

// ------------------------------------------------------------------------------------------------
// Verification
// ------------------------------------------------------------------------------------------------

export type VerificationResult = {
  verified: number;
  alreadyVerified: number;
  skipped: { requirementId: string; text: string; reason: SkipReason }[];
  /** e.g. "3 requirements couldn't be verified: not covered by the current script". */
  messages: string[];
};

/**
 * Applies a report as verification evidence: each requirement with a CONFIRMED passing finding in
 * it (and no confirmed finding of it that did not pass) moves to verified with evidence_report_id =
 * the report, through the requirements state machine (planVerification). Suggestions never count; a
 * verified requirement is never changed (a failing finding never downgrades it). One transaction:
 * session lock, then the requirement rows, then the updates and one activity entry.
 */
export async function applyVerificationFor(userId: string, reportId: string): Promise<VerificationResult> {
  const id = String(reportId);
  return writing(() =>
    withUser(userId, async (tx) => {
      const report = await reportContext(tx, id);
      if (!report) throw new NotFoundError('Report');
      await lockActiveSession(tx, report.session_id);
      const findings = await tx<{ status: FindingStatus; requirement_id: string }[]>`
        select status, requirement_id from public.leads_findings where report_id = ${id} and requirement_id is not null`;
      const ids = [...new Set(findings.map((f) => f.requirement_id))];
      const requirements = ids.length
        ? await tx<Requirement[]>`
            select * from public.requirements where id in ${tx(ids)} and session_id = ${report.session_id}
            order by created_at, id for update`
        : [];
      const plan = planVerification(
        requirements,
        findings.map((f) => ({ status: f.status, requirementId: f.requirement_id })),
        id,
      );
      if (plan.verified.length) {
        await tx`
          update public.requirements set work_state = 'verified', evidence_report_id = ${id}
          where id in ${tx(plan.verified.map((r) => r.id))} and session_id = ${report.session_id} and work_state <> 'verified'`;
      }
      await logActivity(tx, {
        action: 'requirements.verify',
        entityType: 'leads_report',
        entityId: id,
        sessionId: report.session_id,
        meta: {
          verified: plan.verified.length,
          alreadyVerified: plan.alreadyVerified,
          skipped: plan.skipped.length,
          requirementIds: plan.verified.map((r) => r.id),
          skippedReasons: plan.skipped.map((s) => s.reason),
        },
      });
      const skipped = plan.skipped.map((s) => ({ requirementId: s.id, text: s.text, reason: s.reason }));
      return { verified: plan.verified.length, alreadyVerified: plan.alreadyVerified, skipped, messages: skippedMessages(plan.skipped) };
    }),
  );
}

// ------------------------------------------------------------------------------------------------
// Produces (brief): the signed-in user's versions. Throw on failure; the UI uses actions.ts.
// ------------------------------------------------------------------------------------------------

export async function proposeRemediation(input: { sessionId: string; reportId: string }): Promise<Proposal> {
  const user = await requireUser();
  return (await proposeRemediationFor(user.id, input)).proposal;
}

export async function mapFindingsToRequirements(reportId: string): Promise<Array<{ findingId: string; requirementId: string | null }>> {
  const user = await requireUser();
  return (await mapFindingsToRequirementsFor(user.id, reportId)).mappings;
}

export async function applyVerification(reportId: string): Promise<number> {
  const user = await requireUser();
  return (await applyVerificationFor(user.id, reportId)).verified;
}
