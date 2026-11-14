import 'server-only';
import { z } from 'zod';
import { logActivity } from '@/server/activity';
import { requireUser } from '@/server/auth';
import { withUser, type Tx } from '@/server/db/withUser';
import { readPrivate, uploadPrivate, verifyStoredUpload } from '@/server/files/storage';
import type { Evidence, ForensicQuestion, Requirement } from '@/server/db/types';
import type { StepKey } from '@/lib/types';
import { setStepStatusTx } from '@/features/flowchart/steps';
import { STEP_ORDER } from '@/features/flowchart/stepMeta';
import { FlowchartError, NOTE_MAX, READ_ONLY_MESSAGE, EVIDENCE_REQUIRED_MESSAGE } from '@/features/flowchart/types';
import { InvalidTransitionError, transition } from '@/features/requirements/statusMachine';
import {
  ANSWER_MAX,
  defaultEvidenceKind,
  EVIDENCE_EMPTY_MESSAGE,
  EVIDENCE_KINDS,
  EXECUTION_STEPS,
  FORENSIC_OPEN_MESSAGE,
  OVERRIDE_MAX,
  OVERRIDE_MIN,
  OVERRIDE_TOO_LONG_MESSAGE,
  overrideLine,
  POINTS_MAX,
  PROMPT_MAX,
  SUBMIT_EVIDENCE_MESSAGE,
  validPoints,
  type EvidenceKind,
} from './completeRules';

/**
 * Closing the hardening loop (spec 8.1 steps 2, 3, 7, 8; Task 18): forensic questions, evidence,
 * Proposed → Reported, points per audit cycle and the final submission.
 *
 * LOCK ORDER (app-wide, see flowchart/steps.ts): every function here takes the sessions row FIRST
 * (FOR UPDATE where status changes: submitFinal; otherwise FOR NO KEY UPDATE), THEN workflow_steps
 * (inside setStepStatusTx), THEN child rows (requirements, evidence, forensic_questions,
 * remediation_cycles). Completed sessions are read-only: every write refuses with READ_ONLY_MESSAGE
 * before touching a row (the database triggers refuse it too).
 *
 * The `*For(userId, …)` functions take the user id from the caller (server actions pass the session's
 * user); the brief's names (addEvidence, markReported, …) wrap them with requireUser().
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID_RE, 'Invalid id');
const stepKey = z.enum(STEP_ORDER as [StepKey, ...StepKey[]]);
const kindSchema = z.enum(EVIDENCE_KINDS as [EvidenceKind, ...EvidenceKind[]]);

const isReadOnlyError = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '55000';

/** Maps the completed-session trigger's refusal to the same message the explicit check gives. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isReadOnlyError(e)) throw new FlowchartError(READ_ONLY_MESSAGE);
    throw e;
  }
}

/** Locks the session row and refuses a missing or completed session. */
async function lockOpenSession(tx: Tx, sessionId: string, mode: 'normal' | 'update' = 'normal'): Promise<{ current_cycle: number }> {
  const [s] = await tx<{ status: string; current_cycle: number }[]>`
    select status, current_cycle from public.sessions where id = ${sessionId}
    ${mode === 'update' ? tx`for update` : tx`for no key update`}`;
  if (!s) throw new FlowchartError('Session not found');
  if (s.status === 'completed') throw new FlowchartError(READ_ONLY_MESSAGE);
  return s;
}

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new FlowchartError(message);
  return r.data;
}

// ------------------------------------------------------------------------------------------------
// Forensic questions (spec 8.1 step 2)
// ------------------------------------------------------------------------------------------------

export async function addForensicQuestionFor(userId: string, input: { sessionId: string; prompt: string }): Promise<ForensicQuestion> {
  const sessionId = parse(uuid, input.sessionId, 'Session not found');
  const prompt = String(input.prompt ?? '').trim();
  if (prompt === '') throw new FlowchartError('Write the question first');
  if (prompt.length > PROMPT_MAX) throw new FlowchartError(`The question must be ${PROMPT_MAX} characters or fewer`);
  return guarded(() =>
    withUser(userId, async (tx) => {
      await lockOpenSession(tx, sessionId);
      const [q] = await tx<ForensicQuestion[]>`
        insert into public.forensic_questions (session_id, prompt) values (${sessionId}, ${prompt}) returning *`;
      await logActivity(tx, { action: 'forensic.add', entityType: 'forensic_question', entityId: q.id, sessionId, meta: { length: prompt.length } });
      return q;
    }),
  );
}

/** Finds the question's session (RLS: the user's own), then locks session-first before touching the question. */
async function lockQuestion(tx: Tx, id: string): Promise<ForensicQuestion> {
  const [found] = await tx<{ session_id: string }[]>`select session_id from public.forensic_questions where id = ${id}`;
  if (!found) throw new FlowchartError('Question not found');
  await lockOpenSession(tx, found.session_id);
  const [q] = await tx<ForensicQuestion[]>`select * from public.forensic_questions where id = ${id} for update`;
  if (!q) throw new FlowchartError('Question not found');
  return q;
}

/** Records or edits the answer; the question becomes (or stays) answered. */
export async function answerForensicQuestionFor(userId: string, input: { id: string; answer: string }): Promise<ForensicQuestion> {
  const id = parse(uuid, input.id, 'Question not found');
  const answer = String(input.answer ?? '').trim();
  if (answer === '') throw new FlowchartError('Write an answer first');
  if (answer.length > ANSWER_MAX) throw new FlowchartError(`The answer must be ${ANSWER_MAX} characters or fewer`);
  return guarded(() =>
    withUser(userId, async (tx) => {
      const q = await lockQuestion(tx, id);
      const [row] = await tx<ForensicQuestion[]>`
        update public.forensic_questions set answer = ${answer}, status = 'answered' where id = ${id} returning *`;
      await logActivity(tx, {
        action: q.status === 'answered' ? 'forensic.edit' : 'forensic.answer',
        entityType: 'forensic_question',
        entityId: id,
        sessionId: q.session_id,
        meta: { length: answer.length },
      });
      return row;
    }),
  );
}

/** Back to open; the previous answer is kept so it can be edited rather than retyped. */
export async function reopenForensicQuestionFor(userId: string, input: { id: string }): Promise<ForensicQuestion> {
  const id = parse(uuid, input.id, 'Question not found');
  return guarded(() =>
    withUser(userId, async (tx) => {
      const q = await lockQuestion(tx, id);
      if (q.status === 'open') return q;
      const [row] = await tx<ForensicQuestion[]>`update public.forensic_questions set status = 'open' where id = ${id} returning *`;
      await logActivity(tx, { action: 'forensic.reopen', entityType: 'forensic_question', entityId: id, sessionId: q.session_id, meta: {} });
      return row;
    }),
  );
}

export type ForensicView = { sessionStatus: 'active' | 'completed'; questions: ForensicQuestion[] };

/** The session's questions, oldest first; null when the session is not the user's. */
export function getForensicFor(userId: string, sessionId: string): Promise<ForensicView | null> {
  if (!UUID_RE.test(sessionId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const [s] = await tx<{ status: 'active' | 'completed' }[]>`select status from public.sessions where id = ${sessionId}`;
    if (!s) return null;
    const questions = await tx<ForensicQuestion[]>`
      select * from public.forensic_questions where session_id = ${sessionId} order by created_at, id`;
    return { sessionStatus: s.status, questions };
  });
}

export async function addForensicQuestion(input: { sessionId: string; prompt: string }): Promise<ForensicQuestion> {
  return addForensicQuestionFor((await requireUser()).id, input);
}
export async function answerForensicQuestion(input: { id: string; answer: string }): Promise<ForensicQuestion> {
  return answerForensicQuestionFor((await requireUser()).id, input);
}

// ------------------------------------------------------------------------------------------------
// Proposed → Reported
// ------------------------------------------------------------------------------------------------

export type ReportedResult = { reported: number; skipped: number };

/**
 * Inside the caller's transaction (session already locked): requirements of the session whose
 * script_version_id is this version and whose coverage is 'covered' move proposed → reported through
 * the state machine. A potentially disruptive requirement the user has not reviewed is refused by
 * transition() and counted as skipped. NEVER sets verified: only a LEADS report does that.
 */
export async function markReportedTx(tx: Tx, input: { sessionId: string; scriptVersionId: string }): Promise<ReportedResult> {
  const rows = await tx<Requirement[]>`
    select * from public.requirements
    where session_id = ${input.sessionId} and script_version_id = ${input.scriptVersionId}
      and coverage = 'covered' and work_state = 'proposed'
    order by created_at, id for update`;
  const move: string[] = [];
  let skipped = 0;
  for (const r of rows) {
    try {
      transition(r, 'reported');
      move.push(r.id);
    } catch (e) {
      if (!(e instanceof InvalidTransitionError)) throw e;
      skipped++;
    }
  }
  if (move.length) {
    await tx`update public.requirements set work_state = 'reported' where id in ${tx(move)} and session_id = ${input.sessionId} and work_state = 'proposed'`;
  }
  if (move.length || skipped) {
    await logActivity(tx, {
      action: 'requirements.report',
      entityType: 'script_version',
      entityId: input.scriptVersionId,
      sessionId: input.sessionId,
      meta: { reported: move.length, skipped, requirementIds: move },
    });
  }
  return { reported: move.length, skipped };
}

export async function markReportedFor(userId: string, input: { sessionId: string; scriptVersionId: string }): Promise<ReportedResult> {
  const sessionId = parse(uuid, input.sessionId, 'Session not found');
  const scriptVersionId = parse(uuid, input.scriptVersionId, 'Script version not found');
  return guarded(() =>
    withUser(userId, async (tx) => {
      await lockOpenSession(tx, sessionId);
      return markReportedTx(tx, { sessionId, scriptVersionId });
    }),
  );
}

/** Brief: the number of requirements moved Proposed → Reported for this script version. */
export async function markReported(input: { sessionId: string; scriptVersionId: string }): Promise<number> {
  return (await markReportedFor((await requireUser()).id, input)).reported;
}

// ------------------------------------------------------------------------------------------------
// Evidence (spec 8.1 steps 3, 7, 8)
// ------------------------------------------------------------------------------------------------

export type EvidenceInput = {
  sessionId: string;
  step: StepKey;
  kind?: EvidenceKind;
  /** Already uploaded (and verified by the caller): `<user>/<session>/<uuid>-<name>`. */
  storagePath?: string | null;
  note?: string;
  scriptVersionId?: string | null;
};
export type EvidenceResult = { evidence: Evidence; reported: number; skipped: number };

const evidenceSchema = z.object({
  sessionId: uuid,
  step: stepKey,
  kind: kindSchema.optional(),
  storagePath: z.string().min(1).max(600).nullish(),
  note: z.string().max(NOTE_MAX).optional(),
  scriptVersionId: uuid.nullish(),
});

/**
 * Attaches evidence to a step of the session's CURRENT cycle (evidence.cycle_no, set under the session
 * lock, is what the "Complete and Verified needs evidence" guard counts). At least a file or a note.
 * The file must already be in storage under the user's prefix AND this session's segment; the caller
 * verifies type and actual size (verifyStoredUpload) first. The script version must belong to this
 * session or be a universal script's. Execution output with a script version attached to Run hardening
 * script or Targeted remediation also marks that version's covered requirements Reported, in the same
 * transaction. The same storage path attached twice returns the first row (upload retries).
 */
export async function recordEvidenceFor(userId: string, input: EvidenceInput): Promise<EvidenceResult> {
  const data = parse(evidenceSchema, input, `Invalid evidence. A note must be ${NOTE_MAX} characters or fewer`);
  const note = data.note?.trim() || null;
  const storagePath = data.storagePath ?? null;
  if (!storagePath && !note) throw new FlowchartError(EVIDENCE_EMPTY_MESSAGE);
  if (storagePath) {
    const parts = storagePath.split('/');
    if (parts.length !== 3 || parts[0] !== userId || parts[1] !== data.sessionId) throw new FlowchartError('That upload does not belong to this session.');
  }
  const kind = data.kind ?? defaultEvidenceKind(data.step);
  const scriptVersionId = data.scriptVersionId ?? null;

  return guarded(() =>
    withUser(userId, async (tx) => {
      const session = await lockOpenSession(tx, data.sessionId);
      if (scriptVersionId) {
        const [v] = await tx`
          select 1 from public.script_versions v join public.scripts s on s.id = v.script_id
          where v.id = ${scriptVersionId} and (s.session_id = ${data.sessionId} or s.session_id is null)`;
        if (!v) throw new FlowchartError('That script version does not belong to this session');
      }
      if (storagePath) {
        const [existing] = await tx<Evidence[]>`select * from public.evidence where session_id = ${data.sessionId} and storage_path = ${storagePath} limit 1`;
        if (existing) return { evidence: existing, reported: 0, skipped: 0 };
      }
      const [evidence] = await tx<Evidence[]>`
        insert into public.evidence (session_id, step, kind, storage_path, note, script_version_id, cycle_no)
        values (${data.sessionId}, ${data.step}::public.step_key, ${kind}, ${storagePath}, ${note}, ${scriptVersionId}, ${session.current_cycle})
        returning *`;
      let result: ReportedResult = { reported: 0, skipped: 0 };
      if (kind === 'execution_output' && scriptVersionId && EXECUTION_STEPS.includes(data.step)) {
        result = await markReportedTx(tx, { sessionId: data.sessionId, scriptVersionId });
      }
      await logActivity(tx, {
        action: 'evidence.add',
        entityType: 'evidence',
        entityId: evidence.id,
        sessionId: data.sessionId,
        meta: { step: data.step, kind, cycle: session.current_cycle, hasFile: !!storagePath, hasNote: !!note, scriptVersionId, reported: result.reported, skipped: result.skipped },
      });
      return { evidence, ...result };
    }),
  );
}

/**
 * Brief: attaches evidence for the signed-in user. A file is stored under the user's prefix and this
 * session's segment and re-verified (type allowlist, actual size) before its path is recorded.
 */
export async function addEvidence(input: { sessionId: string; step: StepKey; file?: File; note?: string; scriptVersionId?: string; kind?: EvidenceKind }): Promise<EvidenceResult> {
  const user = await requireUser();
  let storagePath: string | null = null;
  if (input.file) {
    const sessionId = parse(uuid, input.sessionId, 'Session not found');
    ({ storagePath } = await uploadPrivate(input.file, { kind: 'evidence', sessionId }));
    await verifyStoredUpload(storagePath, 'evidence');
  }
  return recordEvidenceFor(user.id, { ...input, storagePath });
}

/** The bytes of an evidence file the user owns, with its stored name; null for a missing row, a note-only row or another user's. */
export async function readEvidenceFileFor(userId: string, evidenceId: string): Promise<{ bytes: Uint8Array; filename: string } | null> {
  if (!UUID_RE.test(evidenceId)) return null;
  const row = await withUser(userId, async (tx) => {
    const [e] = await tx<{ storage_path: string | null }[]>`select storage_path from public.evidence where id = ${evidenceId}`;
    return e?.storage_path ?? null;
  });
  if (!row) return null;
  try {
    return { bytes: await readPrivate(row), filename: (row.split('/').pop() ?? '').slice(37) || 'evidence' };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// Points (spec 8.1 step 8; no automatic branch: spec open question Q1)
// ------------------------------------------------------------------------------------------------

export type PointsResult = { cycleNo: number; points: number; target: number | null };

/**
 * Records the points the user read off the scoring page for the CURRENT cycle (remediation_cycles
 * upsert). Only points/target_points ever change: an existing row's outcome (e.g. 'completed') and
 * report are kept. A score is self-reported, never verification, and never branches the workflow.
 */
export async function recordPointsFor(userId: string, input: { sessionId: string; score: number; target?: number | null }): Promise<PointsResult> {
  const sessionId = parse(uuid, input.sessionId, 'Session not found');
  const target = input.target ?? null;
  if (!validPoints(input.score)) throw new FlowchartError(`Points must be a number from 0 to ${POINTS_MAX} with at most 2 decimals`);
  if (target !== null && !validPoints(target)) throw new FlowchartError(`The target must be a number from 0 to ${POINTS_MAX} with at most 2 decimals`);
  return guarded(() =>
    withUser(userId, async (tx) => {
      const session = await lockOpenSession(tx, sessionId);
      await tx`
        insert into public.remediation_cycles (session_id, cycle_no, points, target_points)
        values (${sessionId}, ${session.current_cycle}, ${input.score}, ${target})
        on conflict (session_id, cycle_no) do update
          set points = excluded.points,
              target_points = coalesce(excluded.target_points, public.remediation_cycles.target_points)`;
      await logActivity(tx, {
        action: 'points.record',
        entityType: 'session',
        entityId: sessionId,
        sessionId,
        meta: { cycle: session.current_cycle, points: input.score, target },
      });
      return { cycleNo: session.current_cycle, points: input.score, target };
    }),
  );
}

export async function recordPoints(input: { sessionId: string; score: number; target?: number }): Promise<PointsResult> {
  return recordPointsFor((await requireUser()).id, input);
}

// ------------------------------------------------------------------------------------------------
// Final submission (spec 8.1 step 8, 13.1 step 11)
// ------------------------------------------------------------------------------------------------

/**
 * Submits the session: one transaction that (1) locks the session FOR UPDATE, (2) refuses while any
 * forensic question is open unless `overrideForensics` is a reason of at least 10 characters (kept in
 * the step's notes and history and in the activity log), (3) sets Submit final to Complete and
 * Verified through setStepStatusTx (which refuses without verification evidence of the current cycle),
 * (4) logs, and LAST (5) sets sessions.status = 'completed' and completed_at. A refusal at any point
 * rolls everything back, leaving the session active and untouched. Completed sessions stay viewable.
 */
export async function submitFinalFor(userId: string, sessionId: string, opts: { overrideForensics?: string } = {}): Promise<void> {
  const id = parse(uuid, sessionId, 'Session not found');
  const reason = (opts.overrideForensics ?? '').trim();
  await guarded(() =>
    withUser(userId, async (tx) => {
      const session = await lockOpenSession(tx, id, 'update');
      const [{ n: open }] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.forensic_questions where session_id = ${id} and status = 'open'`;
      let override: string | null = null;
      if (open > 0) {
        if (reason.length < OVERRIDE_MIN) throw new FlowchartError(FORENSIC_OPEN_MESSAGE);
        if (reason.length > OVERRIDE_MAX) throw new FlowchartError(OVERRIDE_TOO_LONG_MESSAGE);
        override = reason;
      }

      let note: string | undefined;
      let eventNote: string | undefined;
      if (override) {
        const line = overrideLine(override);
        const [step] = await tx<{ notes: string | null }[]>`select notes from public.workflow_steps where session_id = ${id} and step = 'submit_final'`;
        const existing = step?.notes?.trim() ?? '';
        note = existing ? `${existing.slice(0, Math.max(0, NOTE_MAX - line.length - 1))}\n${line}` : line;
        eventNote = line;
      }
      try {
        await setStepStatusTx(tx, { sessionId: id, step: 'submit_final', status: 'verified', note, eventNote });
      } catch (e) {
        if (e instanceof FlowchartError && e.message === EVIDENCE_REQUIRED_MESSAGE) throw new FlowchartError(SUBMIT_EVIDENCE_MESSAGE);
        throw e;
      }
      await logActivity(tx, {
        action: 'session.submit',
        entityType: 'session',
        entityId: id,
        sessionId: id,
        meta: { cycle: session.current_cycle, openForensicQuestions: open, override: override !== null, ...(override ? { overrideReason: override } : {}) },
      });
      // LAST: after this the session and every child row are read-only.
      await tx`update public.sessions set status = 'completed', completed_at = now() where id = ${id}`;
    }),
  );
}

export async function submitFinal(sessionId: string, opts: { overrideForensics?: string } = {}): Promise<void> {
  await submitFinalFor((await requireUser()).id, sessionId, opts);
}
