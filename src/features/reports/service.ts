import 'server-only';
import { logActivity } from '@/server/activity';
import { withUser } from '@/server/db/withUser';
import { extractDocument } from '@/server/files/extract';
import { extensionOf, FileTooLargeError, limitFor, UnsupportedFileTypeError, ALLOWED_EXTENSIONS } from '@/server/files/limits';
import { setStepStatusTx } from '@/features/flowchart/steps';
import type { LeadsReport, StepStatus } from '@/lib/types';
import { parseLeadsReport, type Finding } from './parsers';
import { remediationTitle } from './remediationRules';
import { latestHardeningScriptTx } from './sessionScripts';
import { reportTextFromBytes, stripNul } from './text';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

export class NotFoundError extends Error {
  readonly name = 'NotFoundError';
  constructor(what = 'Session') {
    super(`${what} not found`);
  }
}
export class SessionReadOnlyError extends Error {
  readonly name = 'SessionReadOnlyError';
  constructor() {
    super('This session is completed and read-only.');
  }
}
/** The input is not an acceptable report (no text, unreadable). Message is user-facing. */
export class ReportInputError extends Error {
  readonly name = 'ReportInputError';
}

/** Lines of a text, without the empty line a trailing newline leaves at the end. */
function linesOf(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

export type ReportFileInput = { bytes: Uint8Array; filename: string; storagePath?: string | null };

/** What gets stored in leads_reports.parsed (the findings themselves are rows in leads_findings). */
export type StoredParsed = {
  parser: string;
  score: number | null;
  scoreMax: number | null;
  findingCount: number;
  lineCount: number;
  truncated: boolean;
  parseError: string | null;
  parseNote: string | null;
};

/** Plain text of an uploaded report: PDFs via the extractor, everything else via reportTextFromBytes. */
async function textOf(file: ReportFileInput): Promise<string> {
  const ext = extensionOf(file.filename);
  if (!ALLOWED_EXTENSIONS.report.includes(ext)) throw new UnsupportedFileTypeError(file.filename, ALLOWED_EXTENSIONS.report);
  const limit = limitFor(ext, 'report');
  if (file.bytes.byteLength > limit) throw new FileTooLargeError(file.filename, file.bytes.byteLength, limit);
  if (ext === '.pdf') {
    const doc = await extractDocument(file.bytes, file.filename, 'report');
    if (!doc.hasTextLayer) throw new ReportInputError('That PDF has no extractable text. Upload the text output of the LEADS script instead.');
    return stripNul(doc.text);
  }
  return reportTextFromBytes(file.bytes, file.filename).text;
}

/**
 * Records a LEADS report for a session. Text extraction and parsing happen first (no DB held
 * open); then ONE transaction: lock the session row (FOR NO KEY UPDATE, per the app-wide lock
 * order), take its current_cycle, insert the report and its findings, move run_leads from
 * not_started to in_progress (any other status is left alone: never regresses a verified or
 * blocked step), and log the activity (counts only, no filename or content).
 *
 * Replaying the same storagePath for the session returns the report already recorded.
 * Throws NotFoundError, SessionReadOnlyError, ReportInputError and the extractor's errors.
 */
export async function recordLeadsReportFor(userId: string, input: { sessionId: string; file: ReportFileInput }): Promise<LeadsReport> {
  if (!isUuid(input.sessionId)) throw new NotFoundError();
  const raw = await textOf(input.file);
  if (raw.trim() === '') throw new ReportInputError('That report is empty.');
  const parsed = parseLeadsReport(raw);
  const lineCount = linesOf(raw).length;
  const stored: StoredParsed = {
    parser: parsed.parser,
    score: parsed.score,
    scoreMax: parsed.scoreMax ?? null,
    findingCount: parsed.findings.length,
    lineCount,
    truncated: parsed.truncated === true,
    parseError: parsed.parseError ?? null,
    parseNote: parsed.parseNote ?? null,
  };
  const storagePath = input.file.storagePath ?? null;

  return withUser(userId, async (tx) => {
    const [session] = await tx<{ status: 'active' | 'completed'; current_cycle: number }[]>`
      select status, current_cycle from public.sessions where id = ${input.sessionId} for no key update`;
    if (!session) throw new NotFoundError();
    if (session.status === 'completed') throw new SessionReadOnlyError();

    if (storagePath) {
      const [existing] = await tx<LeadsReport[]>`
        select * from public.leads_reports where session_id = ${input.sessionId} and storage_path = ${storagePath} limit 1`;
      if (existing) return existing;
    }

    // Lock order (app-wide): session (above), THEN the step row, then child rows. Only a not_started
    // run_leads moves (to in_progress); verified/blocked/in_progress are never touched.
    const [step] = await tx<{ status: StepStatus }[]>`
      select status from public.workflow_steps where session_id = ${input.sessionId} and step = 'run_leads' for update`;
    if (step?.status === 'not_started') {
      await setStepStatusTx(tx, { sessionId: input.sessionId, step: 'run_leads', status: 'in_progress' });
    }

    const [report] = await tx<LeadsReport[]>`
      insert into public.leads_reports (session_id, cycle_no, filename, storage_path, raw_text, parser, parsed, score)
      values (${input.sessionId}, ${session.current_cycle}, ${input.file.filename.slice(0, 255) || 'report'}, ${storagePath}, ${raw},
              ${parsed.parser}, ${tx.json(stored as never)}, ${parsed.score})
      returning *`;
    if (parsed.findings.length > 0) {
      const rows = parsed.findings.map((f: Finding) => ({
        report_id: report.id,
        title: f.title,
        status: f.status,
        severity: f.severity ?? null,
        category: f.category ?? null,
        // 0 = not located (the column is NOT NULL, check >= 0).
        raw_line: f.rawLine ?? 0,
      }));
      await tx`insert into public.leads_findings ${tx(rows, 'report_id', 'title', 'status', 'severity', 'category', 'raw_line')}`;
    }

    await logActivity(tx, {
      action: 'leads_report.add',
      entityType: 'leads_report',
      entityId: report.id,
      sessionId: input.sessionId,
      meta: { cycle: session.current_cycle, parser: parsed.parser, findings: parsed.findings.length, hasScore: parsed.score !== null, lines: lineCount, truncated: stored.truncated },
    });
    return report;
  });
}

export type ReportSummary = {
  id: string;
  filename: string;
  cycleNo: number;
  createdAt: Date;
  parser: string;
  score: number | null;
  scoreMax: number | null;
  counts: { pass: number; fail: number; unknown: number };
};

export type ReportsOverview = { sessionStatus: 'active' | 'completed'; currentCycle: number; reports: ReportSummary[] };

type Row = { id: string; filename: string; cycle_no: number; created_at: Date; parser: string; score: string | null; parsed: Partial<StoredParsed> };

/** The session's reports, newest first, with finding counts. Null when the session is not the user's. */
export function getReportsOverviewFor(userId: string, sessionId: string): Promise<ReportsOverview | null> {
  if (!isUuid(sessionId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const [session] = await tx<{ status: 'active' | 'completed'; current_cycle: number }[]>`
      select status, current_cycle from public.sessions where id = ${sessionId}`;
    if (!session) return null;
    const reports = await tx<Row[]>`
      select id, filename, cycle_no, created_at, parser, score, parsed from public.leads_reports
      where session_id = ${sessionId} order by created_at desc, id desc`;
    const counts = reports.length
      ? await tx<{ report_id: string; status: 'pass' | 'fail' | 'unknown'; n: number }[]>`
          select report_id, status, count(*)::int as n from public.leads_findings
          where report_id in ${tx(reports.map((r) => r.id))} group by report_id, status`
      : [];
    return {
      sessionStatus: session.status,
      currentCycle: session.current_cycle,
      reports: reports.map((r) => {
        const c = { pass: 0, fail: 0, unknown: 0 };
        for (const k of counts) if (k.report_id === r.id) c[k.status] = k.n;
        return {
          id: r.id,
          filename: r.filename,
          cycleNo: r.cycle_no,
          createdAt: r.created_at,
          parser: r.parser,
          score: r.score === null ? null : Number(r.score),
          scoreMax: r.parsed.scoreMax ?? null,
          counts: c,
        };
      }),
    };
  });
}

export type ReportFinding = {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'unknown';
  severity: string | null;
  category: string | null;
  rawLine: number | null;
  /** The requirement the user confirmed this finding checks (verification evidence). */
  requirementId: string | null;
  /** Claude's suggestion, waiting for the user's Confirm / Change / Clear. */
  suggestedRequirementId: string | null;
};
export type ReportRequirement = { id: string; text: string; workState: 'proposed' | 'reported' | 'verified' };
export type ReportDetail = {
  sessionStatus: 'active' | 'completed';
  report: Omit<ReportSummary, 'counts'> & { lineCount: number; truncated: boolean; parseError: string | null; parseNote: string | null };
  findings: ReportFinding[];
  /** The session's requirements (matrix order), for mapping findings. */
  requirements: ReportRequirement[];
  remediation: {
    /** e.g. "Session hardening · v2": what a remediation would be written against; null when the session has none. */
    hardeningScript: string | null;
    /** The remediation proposal recorded for this report's cycle row, if any. */
    proposal: { id: string; status: 'pending' | 'accepted' | 'rejected'; title: string } | null;
  };
};

/** One report (without its raw text) with its findings in report order. Null when it is not the user's or not in the session. */
export function getReportDetailFor(userId: string, sessionId: string, reportId: string): Promise<ReportDetail | null> {
  if (!isUuid(sessionId) || !isUuid(reportId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const [session] = await tx<{ status: 'active' | 'completed' }[]>`select status from public.sessions where id = ${sessionId}`;
    if (!session) return null;
    const [r] = await tx<Row[]>`
      select id, filename, cycle_no, created_at, parser, score, parsed from public.leads_reports
      where id = ${reportId} and session_id = ${sessionId}`;
    if (!r) return null;
    const findings = await tx<
      { id: string; title: string; status: 'pass' | 'fail' | 'unknown'; severity: string | null; category: string | null; raw_line: number; requirement_id: string | null; suggested_requirement_id: string | null }[]
    >`
      select id, title, status, severity, category, raw_line, requirement_id, suggested_requirement_id from public.leads_findings
      where report_id = ${reportId} order by (raw_line = 0), raw_line, created_at, id`;
    const requirements = await tx<{ id: string; text: string; work_state: ReportRequirement['workState'] }[]>`
      select id, text, work_state from public.requirements where session_id = ${sessionId} order by created_at, id limit 1000`;
    const hardening = await latestHardeningScriptTx(tx, sessionId);
    const [proposal] = await tx<{ id: string; status: 'pending' | 'accepted' | 'rejected'; cycle_no: number; name: string | null }[]>`
      select p.id, p.status, rc.cycle_no, s.name
      from public.remediation_cycles rc join public.proposals p on p.id = rc.proposal_id
      left join public.script_versions v on v.id = p.result_version_id
      left join public.scripts s on s.id = v.script_id
      where rc.session_id = ${sessionId} and rc.report_id = ${reportId}
      order by rc.cycle_no desc limit 1`;
    return {
      sessionStatus: session.status,
      report: {
        id: r.id,
        filename: r.filename,
        cycleNo: r.cycle_no,
        createdAt: r.created_at,
        parser: r.parser,
        score: r.score === null ? null : Number(r.score),
        scoreMax: r.parsed.scoreMax ?? null,
        lineCount: r.parsed.lineCount ?? 0,
        truncated: r.parsed.truncated === true,
        parseError: r.parsed.parseError ?? null,
        parseNote: r.parsed.parseNote ?? null,
      },
      findings: findings.map((f) => ({
        id: f.id,
        title: f.title,
        status: f.status,
        severity: f.severity,
        category: f.category,
        rawLine: f.raw_line > 0 ? f.raw_line : null,
        requirementId: f.requirement_id,
        suggestedRequirementId: f.suggested_requirement_id,
      })),
      requirements: requirements.map((q) => ({ id: q.id, text: q.text, workState: q.work_state })),
      remediation: {
        hardeningScript: hardening ? `${hardening.script.name} · v${hardening.version.version_no}` : null,
        proposal: proposal ? { id: proposal.id, status: proposal.status, title: proposal.name ?? remediationTitle(proposal.cycle_no) } : null,
      },
    };
  });
}

/** A slice of a report's raw text as lines (`offset` 0-based), so a huge report is shown incrementally. */
export function getReportRawLinesFor(
  userId: string,
  sessionId: string,
  reportId: string,
  offset: number,
  limit: number,
): Promise<{ lines: string[]; total: number } | null> {
  if (!isUuid(sessionId) || !isUuid(reportId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const [r] = await tx<{ raw_text: string }[]>`select raw_text from public.leads_reports where id = ${reportId} and session_id = ${sessionId}`;
    if (!r) return null;
    const all = linesOf(r.raw_text);
    const start = Math.max(0, Math.floor(offset));
    return { lines: all.slice(start, start + Math.max(1, Math.floor(limit))), total: all.length };
  });
}
