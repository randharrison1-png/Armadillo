import 'server-only';
import { logActivity } from '@/server/activity';
import { withUser, type Tx } from '@/server/db/withUser';
import { callClaudeTool, ClaudeUpstreamError, ContextTooLargeError, StructuredOutputError, type ClaudeToolResult } from '@/server/claude/client';
import { ForbiddenError } from '@/server/claude/context';
import { adaptationData, adaptationInstruction, MAX_ADAPT_REQUIREMENTS, type AdaptRequirement } from '@/server/claude/prompts/adaptation';
import { ADAPT_TOOL, AdaptationSchema, type Adaptation } from '@/server/claude/schemas';
import { mergeFlags, missingAcknowledgements, requiredFlags, resolveClaudeFlags, scanHighImpact } from '@/server/security/highImpact';
import { MAX_TEXT_BYTES } from '@/server/files/limits';
import { NO_TEXT_MESSAGE } from '@/features/readme/messages';
import { NotFoundError, SessionReadOnlyError } from '@/features/readme/service';
import { insertScriptWithV1 } from '@/features/library/service';
import { ContentTooLargeError, forkToSessionTx, normalizeForLineEnding, saveScriptVersionTx } from '@/features/library/versioning';
import { remediationScriptIdentity, remediationTitle, staleRemediationReason } from '@/features/reports/remediationRules';
import { lineEndingOf } from '@/server/files/encoding';
import { cp1252Encodable } from '@/lib/cp1252';
import { defaultFormat } from '@/features/library/scriptMeta';
import type { Coverage, HighImpactFlag, Proposal, Script, ScriptVersion } from '@/lib/types';
import type { AdaptationOptions, ProposalView } from './types';

/**
 * Adaptation proposals (spec §5.1, §5.4): Claude rewrites a script for the session's README; the user
 * reviews a side-by-side diff, acknowledges every high-impact line, and only then accepts.
 *
 * Invariants:
 *  - Claude never writes a script directly. A proposal is a row; a version exists only after the
 *    user accepts, and then it is saved with author 'claude' on a SESSION script. A universal base
 *    is first forked into the session (ruling R6), so the library script never gains a version.
 *  - Accept requires an acknowledgement for every flag of the proposal AND for every flag a fresh
 *    scan of the final text finds (the user may have edited it). Checked server-side, under the
 *    proposal's row lock, in the same transaction that saves the version and marks the proposal
 *    accepted.
 *  - A session base that moved on since the proposal is a conflict: nothing is saved, the proposal
 *    stays pending, and the user may re-propose against the latest version (no silent rebase).
 *  - Decided proposals are final (also enforced by a trigger, 0004c).
 *
 * The Claude call runs outside any transaction; the proposal is stored afterwards with its activity
 * entry. Activity entries carry ids and counts, never script or README content.
 */

export { NotFoundError, SessionReadOnlyError };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANGE_NOTE_MAX = 500;
const MAX_ACK_IDS = 5000;

/** The request cannot be carried out as asked. Message is user-facing. */
export class AdaptationInputError extends Error {
  readonly name = 'AdaptationInputError';
}

/** The proposal was already accepted or rejected. */
export class ProposalStateError extends Error {
  readonly name = 'ProposalStateError';
  constructor(readonly status: Proposal['status']) {
    super(`This proposal was already ${status}.`);
  }
}

/** Some flags of the final text were not acknowledged; `missing` lists them (the client re-shows the checklist). */
export class FlagsNotAcknowledgedError extends Error {
  readonly name = 'FlagsNotAcknowledgedError';
  constructor(readonly missing: HighImpactFlag[]) {
    super(
      missing.length === 1
        ? 'Acknowledge the remaining high-impact change before accepting.'
        : `Acknowledge the ${missing.length} remaining high-impact changes before accepting.`,
    );
  }
}

/** The session script gained a version after the proposal was made. Nothing was written. */
export class ProposalConflictError extends Error {
  readonly name = 'ProposalConflictError';
  constructor(
    readonly latest: ScriptVersion,
    readonly baseVersionNo: number,
  ) {
    super(`v${latest.version_no} of this script was saved after Claude's proposal (based on v${baseVersionNo}). Nothing was overwritten.`);
  }
}

/** A remediation proposed in an earlier cycle cannot be accepted in a later one. Nothing is written. */
export class StaleRemediationError extends Error {
  readonly name = 'StaleRemediationError';
  constructor(readonly proposalCycle: number | null) {
    super(staleRemediationReason(proposalCycle));
  }
}

/** Something proposals cannot do (e.g. re-proposing a remediation: make a new one from its report). */
export class NotImplementedError extends Error {
  readonly name = 'NotImplementedError';
  constructor(what: string) {
    super(`${what} is not available yet.`);
  }
}

const isReadOnlyError = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '55000';

async function writing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isReadOnlyError(e)) throw new SessionReadOnlyError();
    throw e;
  }
}

async function logFailedRun(userId: string, e: unknown, entry: { entityId: string; sessionId: string }) {
  const code =
    e instanceof StructuredOutputError || e instanceof ClaudeUpstreamError || e instanceof ContextTooLargeError
      ? e.code
      : e instanceof ForbiddenError
        ? 'forbidden'
        : ((e as { code?: unknown })?.code ?? 'error');
  try {
    await withUser(userId, (tx) =>
      logActivity(tx, { action: 'proposal.adapt.failed', entityType: 'script_version', entityId: entry.entityId, sessionId: entry.sessionId, meta: { code: String(code) } }),
    );
  } catch {
    // logging must not hide why the run failed
  }
}

const dateLabel = (d: Date) => `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(d)} UTC`;
const readmeLabel = (r: { created_at: Date; source: string; filename: string | null }) =>
  `${dateLabel(r.created_at)} · ${r.source === 'upload' ? (r.filename ?? 'file') : 'pasted'}`;

/** Claude was told not to, but a whole script wrapped in one Markdown fence is unwrapped (never for Markdown files). */
export function unfence(content: string, language: ScriptVersion['language']): string {
  if (language === 'markdown') return content;
  const m = /^\s*```[\w+-]*[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/.exec(content);
  return m ? `${m[1]}\n` : content;
}

const firstLine = (s: string) => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';

// ------------------------------------------------------------------------------------------------
// Propose
// ------------------------------------------------------------------------------------------------

export type ProposeResult = { proposal: Proposal; filename: string; droppedFlags: number; readmeTrimmed: boolean };

type BaseRow = ScriptVersion & { s_session_id: string | null; s_filename: string; s_name: string };

/**
 * Asks Claude to adapt one script version (of this session, or a universal library script) to one
 * README of the session, and stores the answer as a pending 'adaptation' proposal. Claude sees the
 * README, the script version and — if the session has any — its requirements (text, coverage,
 * suggestion) as untrusted data. The script must reach Claude whole (it is rewritten in full).
 *
 * Stored content: Claude's full script with newlines normalized to the base version's line ending.
 * Stored flags: the scanner's flags for that text unioned with Claude's (one per category + line);
 * Claude flags on lines that do not exist are dropped and counted.
 *
 * Throws NotFoundError, SessionReadOnlyError, AdaptationInputError, and the gateway's errors
 * (ForbiddenError, key errors, ClaudeUpstreamError, StructuredOutputError — also for a script over 2 MB).
 */
export async function proposeAdaptationFor(userId: string, input: { sessionId: string; scriptVersionId: string; readmeId: string }): Promise<ProposeResult> {
  const sessionId = String(input.sessionId);
  const versionId = String(input.scriptVersionId);
  const readmeId = String(input.readmeId);
  if (!UUID_RE.test(sessionId)) throw new NotFoundError();
  if (!UUID_RE.test(readmeId)) throw new NotFoundError('README');
  if (!UUID_RE.test(versionId)) throw new NotFoundError('Script version');

  const { base, requirements } = await withUser(userId, async (tx) => {
    const [session] = await tx<{ status: 'active' | 'completed' }[]>`select status from public.sessions where id = ${sessionId}`;
    if (!session) throw new NotFoundError();
    const [readme] = await tx<{ has_text_layer: boolean; text: string }[]>`
      select has_text_layer, text from public.readmes where id = ${readmeId} and session_id = ${sessionId}`;
    if (!readme) throw new NotFoundError('README');
    const [v] = await tx<BaseRow[]>`
      select v.*, s.session_id as s_session_id, s.filename as s_filename, s.name as s_name
      from public.script_versions v join public.scripts s on s.id = v.script_id
      where v.id = ${versionId} and (s.session_id = ${sessionId} or s.session_id is null)`;
    if (!v) throw new NotFoundError('Script version');
    if (session.status === 'completed') throw new SessionReadOnlyError();
    if (!readme.has_text_layer || !readme.text.trim()) throw new AdaptationInputError(NO_TEXT_MESSAGE);
    const rows = await tx<{ text: string; coverage: Coverage; suggestion: string | null; script_version_id: string | null }[]>`
      select text, coverage, suggestion, script_version_id from public.requirements
      where session_id = ${sessionId} order by created_at, id limit ${MAX_ADAPT_REQUIREMENTS}`;
    const reqs: AdaptRequirement[] = rows.map((r) => ({
      text: r.text,
      coverage: r.coverage,
      suggestion: r.suggestion,
      assessed: r.script_version_id === null ? 'not_assessed' : r.script_version_id === v.id ? 'this_version' : 'other_script',
    }));
    return { base: v, requirements: reqs };
  });

  const scriptRef = { type: 'script_version' as const, id: base.id };
  const failure = { entityId: base.id, sessionId };
  let result: ClaudeToolResult<Adaptation>;
  try {
    result = await callClaudeTool({
      userId,
      sessionId,
      refs: [{ type: 'readme', id: readmeId }, scriptRef],
      data: requirements.length ? [adaptationData(requirements)] : [],
      instruction: () => adaptationInstruction({ language: base.language, filename: base.s_filename, hasRequirements: requirements.length > 0 }),
      tool: ADAPT_TOOL,
      schema: AdaptationSchema,
      untrimmable: [scriptRef],
    });
  } catch (e) {
    await logFailedRun(userId, e, failure);
    if (e instanceof ContextTooLargeError) {
      throw new AdaptationInputError(
        'The script and the README are too long to send to Claude together, and an adaptation needs the whole script. Shorten the script or split it into parts.',
      );
    }
    throw e;
  }

  const content = normalizeForLineEnding(unfence(result.data.content, base.language), base.line_ending);
  if (new TextEncoder().encode(content).length > MAX_TEXT_BYTES) {
    const e = new StructuredOutputError('Adapted script exceeds 2 MB.');
    await logFailedRun(userId, e, failure);
    throw e;
  }
  const scanner = scanHighImpact(content, base.language);
  const { flags: claude, dropped } = resolveClaudeFlags(result.data.flags, content);
  const flags = mergeFlags(scanner, claude);
  const readmeTrimmed = result.trimmed.some((r) => r.type === 'readme');

  const proposal = await writing(() =>
    withUser(userId, async (tx) => {
      const [p] = await tx<Proposal[]>`
        insert into public.proposals (session_id, kind, base_version_id, readme_id, proposed_content, summary, flags)
        values (${sessionId}, 'adaptation', ${base.id}, ${readmeId}, ${content}, ${result.data.summary}, ${tx.json(flags as never)})
        returning *`;
      await logActivity(tx, {
        action: 'proposal.create',
        entityType: 'proposal',
        entityId: p!.id,
        sessionId,
        meta: {
          kind: 'adaptation',
          baseVersionId: base.id,
          scriptId: base.script_id,
          readmeId,
          flags: flags.length,
          scannerFlags: scanner.length,
          claudeFlags: claude.length,
          droppedFlags: dropped,
          readmeTrimmed,
          model: result.model,
          attempts: result.attempts,
        },
      });
      return p!;
    }),
  );
  return { proposal, filename: base.s_filename, droppedFlags: dropped, readmeTrimmed };
}

/** "Re-propose against v<latest>": a new adaptation of the base script's CURRENT version, for the same README. */
export async function reproposeAdaptationFor(userId: string, proposalId: string): Promise<ProposeResult> {
  if (!UUID_RE.test(proposalId)) throw new NotFoundError('Proposal');
  const target = await withUser(userId, async (tx) => {
    const [r] = await tx<{ session_id: string; readme_id: string | null; kind: string; current_version_id: string | null }[]>`
      select p.session_id, p.readme_id, p.kind, s.current_version_id
      from public.proposals p
      left join public.script_versions v on v.id = p.base_version_id
      left join public.scripts s on s.id = v.script_id
      where p.id = ${proposalId}`;
    return r ?? null;
  });
  if (!target) throw new NotFoundError('Proposal');
  if (target.kind !== 'adaptation') throw new NotImplementedError('Re-proposing a remediation');
  if (!target.readme_id) throw new AdaptationInputError('The README this proposal was made for no longer exists. Start a new proposal from the requirements tab.');
  if (!target.current_version_id) throw new NotFoundError('Script version');
  return proposeAdaptationFor(userId, { sessionId: target.session_id, scriptVersionId: target.current_version_id, readmeId: target.readme_id });
}

// ------------------------------------------------------------------------------------------------
// Accept / reject
// ------------------------------------------------------------------------------------------------

export type AcceptResult = { version: ScriptVersion; script: Script; forked: boolean; unchanged: boolean };

/**
 * Lock order (app-wide, flowchart/steps.ts): the proposal's sessions row FIRST (FOR NO KEY UPDATE),
 * then the proposal row, then child rows. Accepting inserts session children (scripts), and a cycle
 * decision holds the session row FOR UPDATE, so taking the proposal first could deadlock.
 */
async function lockProposal(tx: Tx, proposalId: string): Promise<{ proposal: Proposal; sessionStatus: 'active' | 'completed'; currentCycle: number }> {
  const [ref] = UUID_RE.test(proposalId) ? await tx<{ session_id: string }[]>`select session_id from public.proposals where id = ${proposalId}` : [];
  if (!ref) throw new NotFoundError('Proposal');
  const [session] = await tx<{ status: 'active' | 'completed'; current_cycle: number }[]>`
    select status, current_cycle from public.sessions where id = ${ref.session_id} for no key update`;
  if (!session) throw new NotFoundError();
  const [proposal] = await tx<Proposal[]>`select * from public.proposals where id = ${proposalId} for update`;
  if (!proposal) throw new NotFoundError('Proposal');
  return { proposal, sessionStatus: session.status, currentCycle: session.current_cycle };
}

/** The LEADS report filename a remediation proposal answers (its own report_id), or null. */
async function reportFilenameOf(tx: Tx, reportId: string | null): Promise<string | null> {
  if (!reportId) return null;
  const [r] = await tx<{ filename: string }[]>`select filename from public.leads_reports where id = ${reportId}`;
  return r?.filename ?? null;
}

const tooLarge = (s: string) => new TextEncoder().encode(s).length > MAX_TEXT_BYTES;

/**
 * Accepting a remediation (ruling R6): the final text becomes v1 (author 'claude') of a NEW session
 * script "Remediation — Cycle n" (function session_generated; category, OS and format from the base
 * script; filename `remediation-cycle-n<base extension>`). The base script is never changed. Same
 * flag gate and re-scan as an adaptation. Refused (StaleRemediationError) when the proposal's
 * cycle_no is not the session's current cycle: the script is named after proposal.cycle_no and the
 * cycle's remediation_cycles row is pointed at this proposal, so only the current cycle's record is
 * ever touched. Runs inside acceptProposalFor's transaction, after its locks (session row first).
 */
async function acceptRemediationTx(tx: Tx, p: Proposal, currentCycle: number, ack: string[], edited: string | undefined): Promise<AcceptResult> {
  const [base] = p.base_version_id ? await tx<ScriptVersion[]>`select * from public.script_versions where id = ${p.base_version_id}` : [];
  const [baseScript] = base ? await tx<Script[]>`select * from public.scripts where id = ${base.script_id}` : [];
  if (!base || !baseScript || baseScript.session_id !== p.session_id) throw new NotFoundError('Script version');
  if (p.cycle_no === null || p.cycle_no !== currentCycle) throw new StaleRemediationError(p.cycle_no);
  const cycleNo = p.cycle_no;

  const final = normalizeForLineEnding(edited ?? p.proposed_content, base.line_ending);
  if (tooLarge(final)) throw new ContentTooLargeError();
  const required = requiredFlags(Array.isArray(p.flags) ? p.flags : [], final, base.language);
  const missing = missingAcknowledgements(required, ack);
  if (missing.length) throw new FlagsNotAcknowledgedError(missing);

  const names = await tx<{ name: string }[]>`select name from public.scripts where session_id = ${p.session_id}`;
  const { name, filename } = remediationScriptIdentity(cycleNo, baseScript.filename, names.map((n) => n.name));
  const wasEdited = final !== p.proposed_content;
  const changeNote = `Claude remediation${wasEdited ? ' (edited before accepting)' : ''}: ${firstLine(p.summary)}`.slice(0, CHANGE_NOTE_MAX);
  // ANSI scripts that gained characters Windows-1252 cannot store are written as UTF-8 (as saves do).
  const encoding = base.encoding === 'windows-1252' && !cp1252Encodable(final) ? defaultFormat(filename).encoding : base.encoding;
  const script = await insertScriptWithV1(tx, {
    name,
    filename,
    category: baseScript.category,
    fn: 'session_generated',
    description: `Targeted remediation for audit cycle ${cycleNo}, proposed by Claude and accepted after review.`,
    osCompat: baseScript.os_compat,
    content: final,
    format: { encoding, lineEnding: base.line_ending === 'mixed' ? lineEndingOf(final) : base.line_ending },
    language: base.language,
    sessionId: p.session_id,
    author: 'claude',
    changeNote,
    activity: { action: 'script.remediation', meta: { proposalId: p.id, cycle: cycleNo } },
  });
  const [version] = await tx<ScriptVersion[]>`select * from public.script_versions where id = ${script.current_version_id}`;

  await tx`update public.proposals set status = 'accepted', result_version_id = ${version!.id}, updated_at = now() where id = ${p.id}`;
  await tx`
    update public.remediation_cycles set proposal_id = ${p.id}
    where session_id = ${p.session_id} and cycle_no = ${cycleNo} and proposal_id is distinct from ${p.id}`;
  await logActivity(tx, {
    action: 'proposal.accept',
    entityType: 'proposal',
    entityId: p.id,
    sessionId: p.session_id,
    meta: {
      kind: p.kind,
      acknowledgedFlagIds: required.map((f) => f.id),
      baseVersionId: base.id,
      resultVersionId: version!.id,
      scriptId: script.id,
      cycle: cycleNo,
      forked: false,
      edited: wasEdited,
      unchanged: false,
    },
  });
  return { version: version!, script, forked: false, unchanged: false };
}

/**
 * Accepts a pending proposal of an active session, in ONE transaction holding the proposal's row lock:
 *  1. final text = `editedContent ?? proposed_content`, normalized to the base version's line ending;
 *  2. required flags = the stored flags ∪ a fresh scan of the final text (by id); every one must be in
 *     `acknowledgedFlagIds`, else FlagsNotAcknowledgedError listing the missing ones (nothing written);
 *  3. adaptation, universal base → fork the base into the session (v1), then save the final text on the
 *     fork as Claude (v2). Session base → save on that script with base = the proposal's base version;
 *     if the script moved on, ProposalConflictError (nothing written, proposal stays pending);
 *  4. proposal → accepted with result_version_id; activity logged with the acknowledged flag ids.
 * Kind 'remediation': steps 1–2 alike, then a NEW session script at v1 (acceptRemediationTx).
 */
export function acceptProposalFor(
  userId: string,
  input: { proposalId: string; acknowledgedFlagIds: string[]; editedContent?: string },
): Promise<AcceptResult> {
  const proposalId = String(input.proposalId);
  const ack = Array.isArray(input.acknowledgedFlagIds) ? input.acknowledgedFlagIds.filter((s): s is string => typeof s === 'string').slice(0, MAX_ACK_IDS) : [];
  const edited = typeof input.editedContent === 'string' ? input.editedContent : undefined;
  return writing(() =>
    withUser(userId, async (tx) => {
      const { proposal: p, sessionStatus, currentCycle } = await lockProposal(tx, proposalId);
      if (sessionStatus === 'completed') throw new SessionReadOnlyError();
      if (p.status !== 'pending') throw new ProposalStateError(p.status);
      if (p.kind === 'remediation') return acceptRemediationTx(tx, p, currentCycle, ack, edited);

      const [base] = p.base_version_id ? await tx<ScriptVersion[]>`select * from public.script_versions where id = ${p.base_version_id}` : [];
      const [baseScript] = base ? await tx<Script[]>`select * from public.scripts where id = ${base.script_id}` : [];
      if (!base || !baseScript || (baseScript.session_id !== null && baseScript.session_id !== p.session_id)) throw new NotFoundError('Script version');

      const final = normalizeForLineEnding(edited ?? p.proposed_content, base.line_ending);
      const required = requiredFlags(Array.isArray(p.flags) ? p.flags : [], final, base.language);
      const missing = missingAcknowledgements(required, ack);
      if (missing.length) throw new FlagsNotAcknowledgedError(missing);

      const wasEdited = final !== p.proposed_content;
      const changeNote = `Claude adaptation${wasEdited ? ' (edited before accepting)' : ''}: ${firstLine(p.summary)}`.slice(0, CHANGE_NOTE_MAX);
      const forked = baseScript.session_id === null;
      const script = forked ? await forkToSessionTx(tx, { versionId: base.id, sessionId: p.session_id }) : baseScript;
      const saved = await saveScriptVersionTx(tx, {
        scriptId: script.id,
        baseVersionId: forked ? script.current_version_id : base.id,
        content: final,
        changeNote,
        author: 'claude',
      });
      if (saved.status === 'conflict') throw new ProposalConflictError(saved.latest, base.version_no);

      await tx`update public.proposals set status = 'accepted', result_version_id = ${saved.version.id}, updated_at = now() where id = ${p.id}`;
      await logActivity(tx, {
        action: 'proposal.accept',
        entityType: 'proposal',
        entityId: p.id,
        sessionId: p.session_id,
        meta: {
          kind: p.kind,
          acknowledgedFlagIds: required.map((f) => f.id),
          baseVersionId: base.id,
          resultVersionId: saved.version.id,
          scriptId: script.id,
          forked,
          edited: wasEdited,
          unchanged: saved.status === 'unchanged',
        },
      });
      return { version: saved.version, script, forked, unchanged: saved.status === 'unchanged' };
    }),
  );
}

/** Rejects a pending proposal (logged). Nothing else changes. */
export function rejectProposalFor(userId: string, proposalId: string): Promise<void> {
  return writing(() =>
    withUser(userId, async (tx) => {
      const { proposal: p, sessionStatus } = await lockProposal(tx, String(proposalId));
      if (sessionStatus === 'completed') throw new SessionReadOnlyError();
      if (p.status !== 'pending') throw new ProposalStateError(p.status);
      await tx`update public.proposals set status = 'rejected', updated_at = now() where id = ${p.id}`;
      await logActivity(tx, {
        action: 'proposal.reject',
        entityType: 'proposal',
        entityId: p.id,
        sessionId: p.session_id,
        meta: { kind: p.kind, baseVersionId: p.base_version_id },
      });
    }),
  );
}

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

/** The proposal diff tab's data; null when the proposal does not exist or is not the user's. */
export function getProposalViewFor(userId: string, proposalId: string): Promise<ProposalView | null> {
  if (!UUID_RE.test(proposalId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const [proposal] = await tx<Proposal[]>`select * from public.proposals where id = ${proposalId}`;
    if (!proposal) return null;
    const [session] = await tx<{ status: 'active' | 'completed'; current_cycle: number }[]>`
      select status, current_cycle from public.sessions where id = ${proposal.session_id}`;
    const [version] = proposal.base_version_id ? await tx<ScriptVersion[]>`select * from public.script_versions where id = ${proposal.base_version_id}` : [];
    const [script] = version ? await tx<Script[]>`select * from public.scripts where id = ${version.script_id}` : [];
    const [latest] = script?.current_version_id
      ? await tx<{ id: string; version_no: number }[]>`select id, version_no from public.script_versions where id = ${script.current_version_id}`
      : [];
    const [readme] = proposal.readme_id
      ? await tx<{ created_at: Date; source: string; filename: string | null }[]>`select created_at, source, filename from public.readmes where id = ${proposal.readme_id}`
      : [];
    const [result] = proposal.result_version_id
      ? await tx<{ version_id: string; version_no: number; content: string; script_id: string; name: string; filename: string }[]>`
          select v.id as version_id, v.version_no, v.content, s.id as script_id, s.name, s.filename
          from public.script_versions v join public.scripts s on s.id = v.script_id where v.id = ${proposal.result_version_id}`
      : [];
    const sessionStatus = session?.status ?? 'completed';
    const cycleNo = proposal.kind === 'remediation' ? (proposal.cycle_no ?? session?.current_cycle ?? 1) : null;
    const reportFilename = cycleNo !== null ? await reportFilenameOf(tx, proposal.report_id) : null;
    return {
      proposal: { ...proposal, flags: Array.isArray(proposal.flags) ? proposal.flags : [] },
      base: version && script ? { script, version } : null,
      latestBaseVersion: latest ?? null,
      readmeLabel: readme ? readmeLabel(readme) : null,
      sessionStatus,
      readOnly: proposal.status !== 'pending' || sessionStatus === 'completed',
      result: result
        ? { versionId: result.version_id, versionNo: result.version_no, scriptId: result.script_id, scriptName: result.name, filename: result.filename, content: result.content }
        : null,
      remediation: cycleNo !== null ? { cycleNo, title: remediationTitle(cycleNo), reportId: proposal.report_id, reportFilename } : null,
    };
  });
}

/** READMEs of a session (newest first) for "Propose adaptation"; null when the session is not the user's. */
export function getAdaptationOptionsFor(userId: string, sessionId: string): Promise<AdaptationOptions | null> {
  if (!UUID_RE.test(sessionId)) return Promise.resolve(null);
  return withUser(userId, async (tx) => {
    const [session] = await tx<{ status: 'active' | 'completed' }[]>`select status from public.sessions where id = ${sessionId}`;
    if (!session) return null;
    const readmes = await tx<{ id: string; created_at: Date; source: string; filename: string | null; has_text_layer: boolean }[]>`
      select id, created_at, source, filename, has_text_layer from public.readmes where session_id = ${sessionId} order by created_at desc, id`;
    return { active: session.status === 'active', readmes: readmes.map((r) => ({ id: r.id, label: readmeLabel(r), hasText: r.has_text_layer })) };
  });
}
