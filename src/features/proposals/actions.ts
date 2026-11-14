'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/server/auth';
import { ClaudeUpstreamError, StructuredOutputError } from '@/server/claude/client';
import { ForbiddenError } from '@/server/claude/context';
import { ClaudeKeyMissingError, ClaudeKeyUnreadableError } from '@/server/claude/keys';
import { KeyEncryptionConfigError } from '@/server/security/crypto';
import { ContentTooLargeError, ForbiddenEditError } from '@/features/library/versioning';
import type { Proposal, ScriptVersion } from '@/lib/types';
import {
  acceptProposalFor,
  AdaptationInputError,
  FlagsNotAcknowledgedError,
  getAdaptationOptionsFor,
  getProposalViewFor,
  NotFoundError,
  NotImplementedError,
  ProposalConflictError,
  ProposalStateError,
  proposeAdaptationFor,
  rejectProposalFor,
  reproposeAdaptationFor,
  SessionReadOnlyError,
  StaleRemediationError,
  AuditCompleteError,
  type ProposeResult,
} from './service';
import type { AcceptFailure, AcceptOutcome, ActionError, AdaptationOptions, ProposalView, ProposeOutcome, RejectOutcome } from './types';

/** Redirect/auth control-flow errors from requireUser carry a digest and must propagate. */
function rethrowControlFlow(e: unknown) {
  if (typeof e === 'object' && e !== null && 'digest' in e) throw e;
}

function failure(e: unknown, fallback: string): ActionError {
  rethrowControlFlow(e);
  if (e instanceof NotFoundError) return { ok: false, error: 'That session, README, script or proposal no longer exists.' };
  if (
    e instanceof SessionReadOnlyError ||
    e instanceof AdaptationInputError ||
    e instanceof ProposalStateError ||
    e instanceof NotImplementedError ||
    e instanceof StaleRemediationError ||
    e instanceof AuditCompleteError ||
    e instanceof ContentTooLargeError ||
    e instanceof ForbiddenEditError ||
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
  console.error('[proposals] action failed:', e instanceof Error ? e.name : 'unknown error');
  return { ok: false, error: fallback };
}

const proposeOutcome = (r: ProposeResult): ProposeOutcome => ({
  ok: true,
  proposalId: r.proposal.id,
  filename: r.filename,
  flags: r.proposal.flags.length,
  droppedFlags: r.droppedFlags,
  readmeTrimmed: r.readmeTrimmed,
});

const ids = (input: { acknowledgedFlagIds?: unknown }) =>
  Array.isArray(input.acknowledgedFlagIds) ? input.acknowledgedFlagIds.filter((s): s is string => typeof s === 'string') : [];
const edited = (input: { editedContent?: unknown }) => (typeof input.editedContent === 'string' ? input.editedContent : undefined);

// --- Produces (brief): throw on failure. ---

/** Claude adapts a script version to a README of the session; returns the pending proposal. */
export async function proposeAdaptation(input: { sessionId: string; scriptVersionId: string; readmeId: string }): Promise<Proposal> {
  const user = await requireUser();
  return (await proposeAdaptationFor(user.id, input)).proposal;
}

/** Accepts a proposal once every high-impact flag is acknowledged; returns the saved (session) version. */
export async function acceptProposal(input: { proposalId: string; acknowledgedFlagIds: string[]; editedContent?: string }): Promise<ScriptVersion> {
  const user = await requireUser();
  const r = await acceptProposalFor(user.id, { proposalId: String(input.proposalId), acknowledgedFlagIds: ids(input), editedContent: edited(input) });
  revalidatePath('/app', 'layout');
  return r.version;
}

export async function rejectProposal(proposalId: string): Promise<void> {
  const user = await requireUser();
  await rejectProposalFor(user.id, String(proposalId));
}

// --- UI wrappers: user-facing outcomes. ---

export async function proposeAdaptationAction(input: { sessionId: string; scriptVersionId: string; readmeId: string }): Promise<ProposeOutcome | ActionError> {
  try {
    const user = await requireUser();
    return proposeOutcome(await proposeAdaptationFor(user.id, input));
  } catch (e) {
    return failure(e, 'Could not get a proposal from Claude. Try again.');
  }
}

/** "Re-propose against v<latest>" after a conflict: a new proposal on the base script's current version. */
export async function reproposeAdaptationAction(input: { proposalId: string }): Promise<ProposeOutcome | ActionError> {
  try {
    const user = await requireUser();
    return proposeOutcome(await reproposeAdaptationFor(user.id, String(input.proposalId)));
  } catch (e) {
    return failure(e, 'Could not get a proposal from Claude. Try again.');
  }
}

export async function acceptProposalAction(input: { proposalId: string; acknowledgedFlagIds: string[]; editedContent?: string }): Promise<AcceptOutcome | AcceptFailure> {
  try {
    const user = await requireUser();
    const r = await acceptProposalFor(user.id, { proposalId: String(input.proposalId), acknowledgedFlagIds: ids(input), editedContent: edited(input) });
    revalidatePath('/app', 'layout');
    return {
      ok: true,
      versionId: r.version.id,
      versionNo: r.version.version_no,
      scriptId: r.script.id,
      scriptName: r.script.name,
      filename: r.script.filename,
      forked: r.forked,
      unchanged: r.unchanged,
    };
  } catch (e) {
    if (e instanceof FlagsNotAcknowledgedError) return { ok: false, error: e.message, missingFlagIds: e.missing.map((f) => f.id), missingFlags: e.missing };
    if (e instanceof ProposalConflictError) {
      return { ok: false, error: e.message, conflict: { latestVersionId: e.latest.id, latestVersionNo: e.latest.version_no } };
    }
    return failure(e, 'Could not accept the proposal. Try again.');
  }
}

export async function rejectProposalAction(input: { proposalId: string }): Promise<RejectOutcome | ActionError> {
  try {
    const user = await requireUser();
    await rejectProposalFor(user.id, String(input.proposalId));
    return { ok: true };
  } catch (e) {
    return failure(e, 'Could not reject the proposal. Try again.');
  }
}

/** Data for a proposal diff tab; null when it is not the user's. */
export async function loadProposal(proposalId: string): Promise<ProposalView | null> {
  const user = await requireUser();
  return getProposalViewFor(user.id, String(proposalId));
}

/** The session's READMEs, for "Propose adaptation" in a script editor tab; null when not the user's session. */
export async function loadAdaptationOptions(sessionId: string): Promise<AdaptationOptions | null> {
  const user = await requireUser();
  return getAdaptationOptionsFor(user.id, String(sessionId));
}
