'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/server/auth';
import { FileTooLargeError, UnreadableDocumentError, UnsupportedFileTypeError } from '@/server/files/limits';
import { createUploadTarget, ForbiddenFileError, readPrivate, uploadPrivate, verifyStoredUpload, type UploadTarget } from '@/server/files/storage';
import { ClaudeUpstreamError, StructuredOutputError } from '@/server/claude/client';
import { ForbiddenError } from '@/server/claude/context';
import { ClaudeKeyMissingError, ClaudeKeyUnreadableError } from '@/server/claude/keys';
import { KeyEncryptionConfigError } from '@/server/security/crypto';
import type { LeadsReport } from '@/lib/types';
import {
  applyVerificationFor,
  confirmAllSuggestionsFor,
  mapFindingsToRequirementsFor,
  proposeRemediationFor,
  RemediationInputError,
  setFindingRequirementFor,
} from './remediation';
import {
  getReportDetailFor,
  getReportRawLinesFor,
  getReportsOverviewFor,
  NotFoundError,
  recordLeadsReportFor,
  ReportInputError,
  SessionReadOnlyError,
  type ReportDetail,
  type ReportsOverview,
} from './service';

export type ReportActionError = { ok: false; error: string };
export type ReportRecorded = { ok: true; reportId: string; filename: string; parser: string; findings: number };
export type RemediationProposed = { ok: true; proposalId: string; title: string; flags: number; droppedFlags: number };
export type MappingsSuggested = { ok: true; suggested: number; considered: number; dropped: number };
export type SuggestionsConfirmed = { ok: true; confirmed: number };
export type VerificationApplied = { ok: true; verified: number; alreadyVerified: number; messages: string[] };

const revalidate = () => revalidatePath('/app', 'layout');

/** Redirect/auth control-flow errors from requireUser carry a digest and must propagate. */
function rethrowControlFlow(e: unknown) {
  if (typeof e === 'object' && e !== null && 'digest' in e) throw e;
}

function message(e: unknown, fallback: string): string {
  rethrowControlFlow(e);
  if (e instanceof NotFoundError) return 'That session no longer exists.';
  if (e instanceof SessionReadOnlyError || e instanceof ReportInputError || e instanceof UnsupportedFileTypeError || e instanceof FileTooLargeError) return e.message;
  if (e instanceof UnreadableDocumentError) return 'That file could not be read. It may be corrupt or password-protected. Upload the text output of the LEADS script instead.';
  if (e instanceof ForbiddenFileError) return 'That upload does not belong to this session.';
  return fallback;
}

/** Remediation / mapping / verification failures: user-facing text for the errors these can raise. */
function remediationMessage(e: unknown, fallback: string): string {
  rethrowControlFlow(e);
  if (e instanceof NotFoundError) return 'That report, finding or requirement no longer exists in this session.';
  if (
    e instanceof SessionReadOnlyError ||
    e instanceof RemediationInputError ||
    e instanceof ForbiddenError ||
    e instanceof StructuredOutputError ||
    e instanceof ClaudeUpstreamError ||
    e instanceof ClaudeKeyMissingError ||
    e instanceof ClaudeKeyUnreadableError
  ) {
    return e.message;
  }
  if (e instanceof KeyEncryptionConfigError) return 'Claude key storage is not configured on this server. Ask the administrator to set KEY_ENCRYPTION_SECRET.';
  console.error('[reports] remediation action failed:', e instanceof Error ? e.name : 'unknown error');
  return fallback;
}

/** "Propose remediation": Claude writes a targeted script for the report's failing findings (pending proposal). */
export async function proposeRemediationAction(input: { sessionId: string; reportId: string }): Promise<RemediationProposed | ReportActionError> {
  try {
    const user = await requireUser();
    const r = await proposeRemediationFor(user.id, { sessionId: String(input.sessionId), reportId: String(input.reportId) });
    revalidate();
    return { ok: true, proposalId: r.proposal.id, title: r.title, flags: r.proposal.flags.length, droppedFlags: r.droppedFlags };
  } catch (e) {
    return { ok: false, error: remediationMessage(e, 'Could not get a remediation from Claude. Try again.') };
  }
}

/** "Suggest mappings": Claude suggests a requirement per finding; the user confirms each. */
export async function suggestMappingsAction(input: { reportId: string }): Promise<MappingsSuggested | ReportActionError> {
  try {
    const user = await requireUser();
    const r = await mapFindingsToRequirementsFor(user.id, String(input.reportId));
    return { ok: true, suggested: r.suggested, considered: r.mappings.length, dropped: r.dropped };
  } catch (e) {
    return { ok: false, error: remediationMessage(e, 'Could not get suggestions from Claude. Try again.') };
  }
}

/** Confirm / Change (a requirement id) or Clear (null) one finding's mapping. */
export async function setFindingRequirementAction(input: { findingId: string; requirementId: string | null }): Promise<{ ok: true } | ReportActionError> {
  try {
    const user = await requireUser();
    await setFindingRequirementFor(user.id, { findingId: String(input.findingId), requirementId: input.requirementId === null ? null : String(input.requirementId) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: remediationMessage(e, 'Could not save the mapping. Try again.') };
  }
}

export async function confirmAllSuggestionsAction(input: { reportId: string }): Promise<SuggestionsConfirmed | ReportActionError> {
  try {
    const user = await requireUser();
    return { ok: true, ...(await confirmAllSuggestionsFor(user.id, String(input.reportId))) };
  } catch (e) {
    return { ok: false, error: remediationMessage(e, 'Could not confirm the suggestions. Try again.') };
  }
}

/** "Apply verification": confirmed passing findings verify their requirements (evidence = this report). */
export async function applyVerificationAction(input: { reportId: string }): Promise<VerificationApplied | ReportActionError> {
  try {
    const user = await requireUser();
    const r = await applyVerificationFor(user.id, String(input.reportId));
    revalidate();
    return { ok: true, verified: r.verified, alreadyVerified: r.alreadyVerified, messages: r.messages };
  } catch (e) {
    return { ok: false, error: remediationMessage(e, 'Could not apply the verification. Try again.') };
  }
}

/** `<owner>/<session>/<uuid>-<sanitized name>`: the stored name keeps the real extension. */
function originalNameOf(storagePath: string): string {
  return (storagePath.split('/').pop() ?? '').slice(37) || 'report';
}

/**
 * Uploads a report and records it, for server-side callers. Throws on invalid input; the UI uses
 * the *Action wrappers below. Assigns cycle_no = the session's current_cycle and moves run_leads
 * from Not Started to In Progress.
 */
export async function uploadLeadsReport(input: { sessionId: string; file: File }): Promise<LeadsReport> {
  const user = await requireUser();
  const sessionId = String(input.sessionId);
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const { storagePath } = await uploadPrivate(input.file, { kind: 'report', sessionId });
  const report = await recordLeadsReportFor(user.id, { sessionId, file: { bytes, filename: input.file.name, storagePath } });
  revalidate();
  return report;
}

/** Where the browser should upload a report file (validated by type and size first). */
export async function prepareReportUpload(sessionId: string, filename: string, size: number): Promise<{ ok: true; target: UploadTarget } | ReportActionError> {
  try {
    return { ok: true, target: await createUploadTarget({ kind: 'report', sessionId: String(sessionId) }, String(filename), Number(size)) };
  } catch (e) {
    return { ok: false, error: message(e, 'Could not start the upload. Try again.') };
  }
}

/**
 * Records a report the browser already uploaded: the path must be under the user's prefix AND this
 * session's segment, the stored object is re-verified (type and ACTUAL size), its text is
 * extracted and parsed, and report + findings are saved in one transaction.
 */
export async function recordUploadedLeadsReport(input: { sessionId: string; storagePath: string }): Promise<ReportRecorded | ReportActionError> {
  try {
    const user = await requireUser();
    const sessionId = String(input.sessionId);
    const storagePath = String(input.storagePath);
    const parts = storagePath.split('/');
    if (parts[0] !== user.id || parts[1] !== sessionId) throw new ForbiddenFileError();
    await verifyStoredUpload(storagePath, 'report');
    const filename = originalNameOf(storagePath);
    const report = await recordLeadsReportFor(user.id, { sessionId, file: { bytes: await readPrivate(storagePath), filename, storagePath } });
    revalidate();
    const parsed = report.parsed as { findingCount?: number };
    return { ok: true, reportId: report.id, filename: report.filename, parser: report.parser, findings: Number(parsed.findingCount ?? 0) };
  } catch (e) {
    return { ok: false, error: message(e, 'Could not save the uploaded report. Try again.') };
  }
}

/** Data for the reports list: the session's reports (newest first) with finding counts. Null when the session is not the user's. */
export async function loadReportsView(sessionId: string): Promise<ReportsOverview | null> {
  const user = await requireUser();
  return getReportsOverviewFor(user.id, String(sessionId));
}

/** Data for one report's tab: metadata and findings (the raw text is loaded on demand). */
export async function loadReportView(sessionId: string, reportId: string): Promise<ReportDetail | null> {
  const user = await requireUser();
  return getReportDetailFor(user.id, String(sessionId), String(reportId));
}

/** A page of a report's raw text, as lines. */
export async function loadReportRaw(sessionId: string, reportId: string, offset: number, limit: number): Promise<{ lines: string[]; total: number } | null> {
  const user = await requireUser();
  return getReportRawLinesFor(user.id, String(sessionId), String(reportId), Number(offset) || 0, Math.min(Math.max(Number(limit) || 1000, 1), 5000));
}
