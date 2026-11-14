import 'server-only';
import { logActivity } from '@/server/activity';
import { withUser, type Tx } from '@/server/db/withUser';
import { callClaudeTool, ClaudeUpstreamError, StructuredOutputError, type ClaudeToolResult } from '@/server/claude/client';
import { ForbiddenError } from '@/server/claude/context';
import { assessmentInstruction, extractionInstruction } from '@/server/claude/prompts/requirements';
import { ASSESS_TOOL, AssessmentSchema, EXTRACT_TOOL, ExtractionSchema, MAX_EXTRACTED, type Assessment, type Extraction } from '@/server/claude/schemas';
import { NO_TEXT_MESSAGE } from '@/features/readme/messages';
import { NotFoundError, SessionReadOnlyError } from '@/features/readme/service';
import type { Coverage, Requirement, ResourceRef } from '@/lib/types';
import { resolveAssessments, resolveExtracted } from './mapping';
import type { ReadmeOption, RequirementRow, RequirementsView, ScriptVersionOption } from './types';

/**
 * Requirements (spec §5.3): Claude reads a session's README and lists its requirements, each tied to
 * the README segment it came from; then assesses which ones a selected script version covers.
 *
 * Claude only ever sees the resources named here (buildContext checks them against the session):
 * extraction sends the chosen README alone; assessment sends the README(s) the requirements came
 * from plus the chosen script version. Nothing here moves a requirement past 'proposed': an
 * assessment is not proof that the machine is hardened (see statusMachine.ts for the other states).
 *
 * The Claude call happens OUTSIDE any transaction (it can take a minute); the results are written
 * afterwards in one transaction with the activity entry. Each run is logged (counts, never content),
 * failed runs too.
 */

export { NotFoundError, SessionReadOnlyError };

/** The request cannot be carried out as asked. Message is user-facing. */
export class RequirementsInputError extends Error {
  readonly name = 'RequirementsInputError';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NOTES_MAX = 4000;
const VIEW_LIMIT = 1000;

async function sessionStatusOf(tx: Tx, sessionId: string): Promise<'active' | 'completed' | null> {
  const [s] = await tx<{ status: 'active' | 'completed' }[]>`select status from public.sessions where id = ${sessionId}`;
  return s?.status ?? null;
}

/** 55000 is raised by assert_session_writable() when the session was completed meanwhile. */
const isReadOnlyError = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '55000';

async function writing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isReadOnlyError(e)) throw new SessionReadOnlyError();
    throw e;
  }
}

/** Best effort: a failed Claude run is logged (its error code only). Never masks the original error. */
async function logFailedRun(userId: string, e: unknown, entry: { action: string; entityType: string; entityId: string; sessionId: string }) {
  const code =
    e instanceof StructuredOutputError || e instanceof ClaudeUpstreamError ? e.code : e instanceof ForbiddenError ? 'forbidden' : ((e as { code?: unknown })?.code ?? 'error');
  try {
    await withUser(userId, (tx) => logActivity(tx, { ...entry, meta: { code: String(code) } }));
  } catch {
    // logging must not hide why the run failed
  }
}

// ------------------------------------------------------------------------------------------------
// Extraction
// ------------------------------------------------------------------------------------------------

export type ExtractResult = {
  /** The rows inserted by this run, in extraction order. */
  requirements: Requirement[];
  inserted: number;
  /** Items Claude returned without a valid citation of a README segment. */
  dropped: number;
  /** Earlier proposed, note-less rows of this README that this run replaced. */
  replaced: number;
  /** Earlier rows of this README that were kept (reported, verified or with notes). */
  kept: number;
  /** The README was shortened to fit Claude's context. */
  trimmed: boolean;
};

/**
 * Extracts the requirements of one README of the session. Every item must cite a segment of THAT
 * README; items that do not are dropped and counted. New rows: coverage 'detected', work_state
 * 'proposed'. Re-extraction replaces only this README's rows that are still 'proposed' and have no
 * notes; reported, verified and annotated rows are kept.
 *
 * Throws NotFoundError, SessionReadOnlyError, RequirementsInputError (README without text), and the
 * gateway's errors (ForbiddenError, key errors, ClaudeUpstreamError, StructuredOutputError).
 */
export async function extractRequirementsFor(userId: string, input: { sessionId: string; readmeId: string }): Promise<ExtractResult> {
  const sessionId = String(input.sessionId);
  const readmeId = String(input.readmeId);
  if (!UUID_RE.test(sessionId)) throw new NotFoundError();
  if (!UUID_RE.test(readmeId)) throw new NotFoundError('README');

  const segmentIds = await withUser(userId, async (tx) => {
    const status = await sessionStatusOf(tx, sessionId);
    if (!status) throw new NotFoundError();
    const [r] = await tx<{ has_text_layer: boolean; ids: (string | null)[] }[]>`
      select has_text_layer,
             coalesce((select jsonb_agg(e ->> 'id') from jsonb_array_elements(
                        case when jsonb_typeof(segments) = 'array' then segments else '[]'::jsonb end) e), '[]'::jsonb) as ids
      from public.readmes where id = ${readmeId} and session_id = ${sessionId}`;
    if (!r) throw new NotFoundError('README');
    if (status === 'completed') throw new SessionReadOnlyError();
    const ids = r.ids.filter((id): id is string => typeof id === 'string' && id !== '');
    if (!r.has_text_layer || ids.length === 0) throw new RequirementsInputError(NO_TEXT_MESSAGE);
    return ids;
  });

  const failure = { action: 'requirements.extract.failed', entityType: 'readme', entityId: readmeId, sessionId };
  let result: ClaudeToolResult<Extraction>;
  try {
    result = await callClaudeTool({
      userId,
      sessionId,
      refs: [{ type: 'readme', id: readmeId }],
      instruction: extractionInstruction,
      tool: EXTRACT_TOOL,
      schema: ExtractionSchema,
    });
  } catch (e) {
    await logFailedRun(userId, e, failure);
    throw e;
  }

  const { kept: items, dropped } = resolveExtracted(result.data.requirements, segmentIds, result.nonce);
  const trimmed = result.trimmed.length > 0;
  return writing(() =>
    withUser(userId, async (tx) => {
      // Serializes concurrent runs for the same README (each replaces the other's proposed rows).
      const [locked] = await tx`select id from public.readmes where id = ${readmeId} and session_id = ${sessionId} for update`;
      if (!locked) throw new NotFoundError('README');
      const removed = await tx`
        delete from public.requirements
        where readme_id = ${readmeId} and work_state = 'proposed' and coalesce(btrim(notes, E' \\t\\r\\n'), '') = ''
        returning id`;
      const [{ count: keptCount }] = await tx<{ count: number }[]>`
        select count(*)::int as count from public.requirements where readme_id = ${readmeId}`;
      const rows = items.length
        ? await tx<Requirement[]>`
            with inserted as (
              insert into public.requirements
                (session_id, readme_id, text, segment_id, category, disruptive, automatable, coverage, work_state, created_at)
              select ${sessionId}, ${readmeId}, x.text, x.segment_id, x.category, x.disruptive, x.automatable,
                     'detected', 'proposed', now() + (x.ord * interval '1 microsecond')
              from rows from (jsonb_to_recordset(${tx.json(items as never)})
                     as (text text, segment_id text, category text, disruptive boolean, automatable boolean))
                   with ordinality as x(text, segment_id, category, disruptive, automatable, ord)
              returning *
            )
            select * from inserted order by created_at, id`
        : [];
      await logActivity(tx, {
        action: 'requirements.extract',
        entityType: 'readme',
        entityId: readmeId,
        sessionId,
        meta: { inserted: rows.length, dropped, replaced: removed.length, kept: keptCount, trimmed, model: result.model, attempts: result.attempts },
      });
      return { requirements: rows, inserted: rows.length, dropped, replaced: removed.length, kept: keptCount, trimmed };
    }),
  );
}

// ------------------------------------------------------------------------------------------------
// Coverage assessment
// ------------------------------------------------------------------------------------------------

export type AssessResult = {
  /** Every requirement of the session after the run, in matrix order. */
  requirements: Requirement[];
  assessed: number;
  /** Assessment items naming no listed requirement (or repeating one). */
  ignored: number;
  /** Listed requirements Claude did not assess: back to 'detected', with no script. */
  unassessed: number;
  /** Reported or verified requirements, which an assessment never touches. */
  skipped: number;
  trimmed: boolean;
  scriptLabel: string;
};

/**
 * Assesses the session's PROPOSED requirements against one script version (a script of this
 * session, or a universal library script). Coverage per spec §5.3 (see coverageFor): covered,
 * missing (+ suggestion), needs_review (potentially disruptive), manual (not safely automatable).
 * work_state stays 'proposed'; script_version_id records what was assessed. Listed requirements
 * Claude skipped lose any earlier coverage (it would describe another script).
 */
export async function assessCoverageFor(userId: string, input: { sessionId: string; scriptVersionId: string }): Promise<AssessResult> {
  const sessionId = String(input.sessionId);
  const scriptVersionId = String(input.scriptVersionId);
  if (!UUID_RE.test(sessionId)) throw new NotFoundError();
  if (!UUID_RE.test(scriptVersionId)) throw new ForbiddenError();

  const pre = await withUser(userId, async (tx) => {
    const status = await sessionStatusOf(tx, sessionId);
    if (!status) throw new NotFoundError();
    if (status === 'completed') throw new SessionReadOnlyError();
    const [v] = await tx<{ name: string; version_no: number }[]>`
      select s.name, v.version_no from public.script_versions v join public.scripts s on s.id = v.script_id
      where v.id = ${scriptVersionId} and (s.session_id = ${sessionId} or s.session_id is null)`;
    if (!v) throw new ForbiddenError();
    const reqs = await tx<{ id: string; readme_id: string; text: string; segment_id: string }[]>`
      select id, readme_id, text, segment_id from public.requirements
      where session_id = ${sessionId} and work_state = 'proposed'
      order by created_at, id limit ${MAX_EXTRACTED}`;
    const [{ count: skipped }] = await tx<{ count: number }[]>`
      select count(*)::int as count from public.requirements where session_id = ${sessionId} and work_state <> 'proposed'`;
    if (reqs.length === 0) {
      throw new RequirementsInputError('There are no proposed requirements to assess. Extract requirements from the README first.');
    }
    return { scriptLabel: `${v.name} · v${v.version_no}`, reqs, skipped };
  });

  const keys = new Map(pre.reqs.map((r, i) => [`R${i + 1}`, r.id]));
  const refs: ResourceRef[] = [...new Set(pre.reqs.map((r) => r.readme_id))].map((id) => ({ type: 'readme', id }));
  refs.push({ type: 'script_version', id: scriptVersionId });
  const listed = pre.reqs.map((r, i) => ({ key: `R${i + 1}`, text: r.text, segmentId: r.segment_id }));

  const failure = { action: 'requirements.assess.failed', entityType: 'script_version', entityId: scriptVersionId, sessionId };
  let result: ClaudeToolResult<Assessment>;
  try {
    result = await callClaudeTool({
      userId,
      sessionId,
      refs,
      instruction: (nonce) => assessmentInstruction(nonce, listed),
      tool: ASSESS_TOOL,
      schema: AssessmentSchema,
    });
  } catch (e) {
    await logFailedRun(userId, e, failure);
    throw e;
  }

  const { updates, ignored } = resolveAssessments(result.data.assessments, keys);
  const rest = pre.reqs.map((r) => r.id).filter((id) => !updates.has(id));
  const trimmed = result.trimmed.length > 0;
  return writing(() =>
    withUser(userId, async (tx) => {
      const payload = [...updates].map(([id, u]) => ({ id, ...u }));
      const assessed = payload.length
        ? await tx`
            update public.requirements r
            set coverage = u.coverage::public.coverage, suggestion = u.suggestion, disruptive = u.disruptive,
                automatable = u.automatable, script_version_id = ${scriptVersionId}
            from jsonb_to_recordset(${tx.json(payload as never)})
                 as u(id uuid, coverage text, suggestion text, disruptive boolean, automatable boolean)
            where r.id = u.id and r.session_id = ${sessionId} and r.work_state = 'proposed'
            returning r.id`
        : [];
      const reset = rest.length
        ? await tx`
            update public.requirements set coverage = 'detected', suggestion = null, script_version_id = null
            where id in ${tx(rest)} and session_id = ${sessionId} and work_state = 'proposed'
            returning id`
        : [];
      const byCoverage: Partial<Record<Coverage, number>> = {};
      for (const u of updates.values()) byCoverage[u.coverage] = (byCoverage[u.coverage] ?? 0) + 1;
      await logActivity(tx, {
        action: 'requirements.assess',
        entityType: 'script_version',
        entityId: scriptVersionId,
        sessionId,
        meta: { assessed: assessed.length, ignored, unassessed: reset.length, skipped: pre.skipped, coverage: byCoverage, trimmed, model: result.model, attempts: result.attempts },
      });
      const requirements = await tx<Requirement[]>`
        select * from public.requirements where session_id = ${sessionId} order by created_at, id`;
      return { requirements, assessed: assessed.length, ignored, unassessed: reset.length, skipped: pre.skipped, trimmed, scriptLabel: pre.scriptLabel };
    }),
  );
}

// ------------------------------------------------------------------------------------------------
// Notes and the matrix view
// ------------------------------------------------------------------------------------------------

/** Sets (or clears, when blank) the user's notes on a requirement. */
export async function updateRequirementNotesFor(userId: string, input: { requirementId: string; notes: string }): Promise<{ notes: string | null }> {
  const requirementId = String(input.requirementId);
  const clean = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (clean.length > NOTES_MAX) throw new RequirementsInputError(`Notes are limited to ${NOTES_MAX} characters.`);
  if (!UUID_RE.test(requirementId)) throw new NotFoundError('Requirement');
  return writing(() =>
    withUser(userId, async (tx) => {
      const [r] = await tx<{ session_id: string; status: 'active' | 'completed' }[]>`
        select r.session_id, s.status from public.requirements r join public.sessions s on s.id = r.session_id
        where r.id = ${requirementId}`;
      if (!r) throw new NotFoundError('Requirement');
      if (r.status === 'completed') throw new SessionReadOnlyError();
      const [row] = await tx<{ notes: string | null }[]>`
        update public.requirements set notes = ${clean || null} where id = ${requirementId} returning notes`;
      await logActivity(tx, {
        action: 'requirement.notes',
        entityType: 'requirement',
        entityId: requirementId,
        sessionId: r.session_id,
        meta: { cleared: !clean, length: clean.length },
      });
      return { notes: row.notes };
    }),
  );
}

const dateLabel = (d: Date) => `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(d)} UTC`;

type ViewRow = {
  id: string;
  readme_id: string;
  text: string;
  segment_id: string;
  category: string | null;
  coverage: Coverage;
  work_state: Requirement['work_state'];
  disruptive: boolean;
  automatable: boolean;
  suggestion: string | null;
  notes: string | null;
  script_version_id: string | null;
  evidence_report_id: string | null;
  source_kind: string | null;
  source_index: number | null;
  script_label: string | null;
  evidence_label: string | null;
};

/** Everything the requirements tab shows for a session; null when the session is not the user's. */
export function getRequirementsViewFor(userId: string, sessionId: string): Promise<RequirementsView | null> {
  if (!UUID_RE.test(sessionId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const status = await sessionStatusOf(tx, sessionId);
    if (!status) return null;
    const readmes = await tx<{ id: string; source: 'paste' | 'upload'; filename: string | null; has_text_layer: boolean; created_at: Date }[]>`
      select id, source, filename, has_text_layer, created_at from public.readmes
      where session_id = ${sessionId} order by created_at desc, id`;
    const scripts = await tx<{ id: string; name: string; version_no: number; session_id: string | null }[]>`
      select v.id, s.name, v.version_no, s.session_id
      from public.scripts s join public.script_versions v on v.id = s.current_version_id
      where s.archived_at is null and s.function <> 'leads_audit' and (s.session_id = ${sessionId} or s.session_id is null)
      order by (s.session_id is null), lower(s.name), s.id limit 200`;
    // Each README's segments are expanded once, to find every requirement's position.
    const rows = await tx<ViewRow[]>`
      with segs as (
        select distinct on (m.id, e ->> 'id') m.id as readme_id, e ->> 'id' as seg_id, e ->> 'kind' as kind, (e ->> 'index')::int as idx
        from public.readmes m cross join lateral jsonb_array_elements(
          case when jsonb_typeof(m.segments) = 'array' then m.segments else '[]'::jsonb end) e
        where m.session_id = ${sessionId}
      )
      select r.id, r.readme_id, r.text, r.segment_id, r.category, r.coverage, r.work_state, r.disruptive, r.automatable,
             r.suggestion, r.notes, r.script_version_id, r.evidence_report_id,
             segs.kind as source_kind, segs.idx as source_index,
             case when sv.id is null then null else s.name || ' · v' || sv.version_no end as script_label,
             case when lr.id is null then null else lr.filename || ' · cycle ' || lr.cycle_no end as evidence_label
      from public.requirements r
      left join segs on segs.readme_id = r.readme_id and segs.seg_id = r.segment_id
      left join public.script_versions sv on sv.id = r.script_version_id
      left join public.scripts s on s.id = sv.script_id
      left join public.leads_reports lr on lr.id = r.evidence_report_id
      where r.session_id = ${sessionId}
      order by r.created_at, r.id
      limit ${VIEW_LIMIT}`;
    const readmeOptions: ReadmeOption[] = readmes.map((r) => ({
      id: r.id,
      label: `${dateLabel(r.created_at)} · ${r.source === 'upload' ? (r.filename ?? 'file') : 'pasted'}`,
      hasText: r.has_text_layer,
    }));
    const scriptOptions: ScriptVersionOption[] = scripts.map((v) => ({
      id: v.id,
      label: `${v.name} · v${v.version_no}`,
      scope: v.session_id === sessionId ? 'session' : 'library',
    }));
    const requirements: RequirementRow[] = rows.map((r) => ({
      id: r.id,
      readmeId: r.readme_id,
      text: r.text,
      segmentId: r.segment_id,
      sourceKind: r.source_kind === 'paragraph' || r.source_kind === 'page' ? r.source_kind : null,
      sourceIndex: r.source_kind === 'paragraph' || r.source_kind === 'page' ? r.source_index : null,
      category: r.category,
      coverage: r.coverage,
      workState: r.work_state,
      disruptive: r.disruptive,
      automatable: r.automatable,
      suggestion: r.suggestion,
      notes: r.notes,
      scriptVersionId: r.script_version_id,
      scriptLabel: r.script_label,
      evidenceReportId: r.evidence_report_id,
      evidenceLabel: r.evidence_label,
    }));
    return { sessionStatus: status, readmes: readmeOptions, scriptOptions, requirements };
  });
}
