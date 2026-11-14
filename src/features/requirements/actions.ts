'use server';

import { requireUser } from '@/server/auth';
import { ClaudeUpstreamError, StructuredOutputError } from '@/server/claude/client';
import { ForbiddenError } from '@/server/claude/context';
import { ClaudeKeyMissingError, ClaudeKeyUnreadableError } from '@/server/claude/keys';
import { KeyEncryptionConfigError } from '@/server/security/crypto';
import type { Requirement } from '@/lib/types';
import {
  assessCoverageFor,
  extractRequirementsFor,
  getRequirementsViewFor,
  markRequirementReviewedFor,
  NotFoundError,
  RequirementsInputError,
  SessionReadOnlyError,
  updateRequirementNotesFor,
} from './service';
import type { ActionError, AssessOutcome, ExtractOutcome, NotesOutcome, RequirementsView, ReviewOutcome } from './types';

/** Redirect/auth control-flow errors from requireUser carry a digest and must propagate. */
function rethrowControlFlow(e: unknown) {
  if (typeof e === 'object' && e !== null && 'digest' in e) throw e;
}

function failure(e: unknown, fallback: string): ActionError {
  rethrowControlFlow(e);
  if (e instanceof NotFoundError) return { ok: false, error: 'That session, README or requirement no longer exists.' };
  if (
    e instanceof SessionReadOnlyError ||
    e instanceof RequirementsInputError ||
    e instanceof ForbiddenError ||
    e instanceof StructuredOutputError ||
    e instanceof ClaudeUpstreamError ||
    e instanceof ClaudeKeyMissingError ||
    e instanceof ClaudeKeyUnreadableError
  ) {
    return { ok: false, error: e.message };
  }
  if (e instanceof KeyEncryptionConfigError) {
    return { ok: false, error: 'Claude key storage is not configured on this server. Ask the administrator to set KEY_ENCRYPTION_SECRET.' };
  }
  console.error('[requirements] action failed:', e instanceof Error ? e.name : 'unknown error');
  return { ok: false, error: fallback };
}

/** Extracts a README's requirements (see extractRequirementsFor). Returns the inserted rows; throws on failure. */
export async function extractRequirements(input: { sessionId: string; readmeId: string }): Promise<Requirement[]> {
  const user = await requireUser();
  return (await extractRequirementsFor(user.id, { sessionId: String(input.sessionId), readmeId: String(input.readmeId) })).requirements;
}

/** Assesses the session's proposed requirements against a script version. Returns every session requirement; throws on failure. */
export async function assessCoverage(input: { sessionId: string; scriptVersionId: string }): Promise<Requirement[]> {
  const user = await requireUser();
  return (await assessCoverageFor(user.id, { sessionId: String(input.sessionId), scriptVersionId: String(input.scriptVersionId) })).requirements;
}

/** UI wrapper of extractRequirements: counts, or a user-facing error. */
export async function extractRequirementsAction(input: { sessionId: string; readmeId: string }): Promise<ExtractOutcome | ActionError> {
  try {
    const user = await requireUser();
    const r = await extractRequirementsFor(user.id, { sessionId: String(input.sessionId), readmeId: String(input.readmeId) });
    return { ok: true, inserted: r.inserted, dropped: r.dropped, replaced: r.replaced, kept: r.kept, trimmed: r.trimmed };
  } catch (e) {
    return failure(e, 'Could not extract the requirements. Try again.');
  }
}

/** UI wrapper of assessCoverage: counts, or a user-facing error. */
export async function assessCoverageAction(input: { sessionId: string; scriptVersionId: string }): Promise<AssessOutcome | ActionError> {
  try {
    const user = await requireUser();
    const r = await assessCoverageFor(user.id, { sessionId: String(input.sessionId), scriptVersionId: String(input.scriptVersionId) });
    return { ok: true, assessed: r.assessed, ignored: r.ignored, unassessed: r.unassessed, skipped: r.skipped, trimmed: r.trimmed, scriptLabel: r.scriptLabel };
  } catch (e) {
    return failure(e, 'Could not assess coverage. Try again.');
  }
}

export async function saveRequirementNotes(input: { requirementId: string; notes: string }): Promise<NotesOutcome | ActionError> {
  try {
    const user = await requireUser();
    const r = await updateRequirementNotesFor(user.id, { requirementId: String(input.requirementId), notes: String(input.notes ?? '') });
    return { ok: true, notes: r.notes };
  } catch (e) {
    return failure(e, 'Could not save the note. Try again.');
  }
}

/** "Mark reviewed" on a potentially disruptive requirement (logged; refused on completed sessions). */
export async function markRequirementReviewed(input: { requirementId: string }): Promise<ReviewOutcome | ActionError> {
  try {
    const user = await requireUser();
    const r = await markRequirementReviewedFor(user.id, { requirementId: String(input.requirementId) });
    return { ok: true, reviewedAt: r.reviewedAt.toISOString() };
  } catch (e) {
    return failure(e, 'Could not mark the requirement reviewed. Try again.');
  }
}

/** Data for the requirements tab; null when the session is not the user's. */
export async function loadRequirementsView(sessionId: string): Promise<RequirementsView | null> {
  const user = await requireUser();
  return getRequirementsViewFor(user.id, String(sessionId));
}
