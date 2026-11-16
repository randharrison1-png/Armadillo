'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/server/auth';
import { FileTooLargeError, UnsupportedFileTypeError } from '@/server/files/limits';
import { createUploadTarget, ForbiddenFileError, verifyStoredUpload, type UploadTarget } from '@/server/files/storage';
import { FlowchartError } from '@/features/flowchart/types';
import type { StepKey } from '@/lib/types';
import {
  addForensicQuestionFor,
  answerForensicQuestionFor,
  getForensicFor,
  recordEvidenceFor,
  recordPointsFor,
  reopenForensicQuestionFor,
  submitFinalFor,
} from './complete';
import type { EvidenceKind, ForensicItem } from './completeRules';

export type ActionError = { ok: false; error: string };
type Ok<T = object> = { ok: true } & T;

function failure(e: unknown, fallback: string): ActionError {
  // Redirect/auth control-flow errors from requireUser carry a digest and must propagate.
  if (typeof e === 'object' && e !== null && 'digest' in e) throw e;
  if (e instanceof FlowchartError || e instanceof UnsupportedFileTypeError || e instanceof FileTooLargeError) return { ok: false, error: e.message };
  if (e instanceof ForbiddenFileError) return { ok: false, error: 'That upload does not belong to this session.' };
  console.error('[sessions] action failed:', e instanceof Error ? e.name : 'unknown error');
  return { ok: false, error: fallback };
}

const touch = (sessionId: string) => revalidatePath(`/app/sessions/${sessionId}`);

// ---- forensic questions -------------------------------------------------------------------------

type QuestionRow = { id: string; prompt: string; answer: string | null; status: 'open' | 'answered'; updated_at: Date };
const item = (q: QuestionRow): ForensicItem => ({ id: q.id, prompt: q.prompt, answer: q.answer, status: q.status, updatedAt: q.updated_at.toISOString() });

/** The session's questions (oldest first); null when the session is not the user's. */
export async function loadForensic(sessionId: string): Promise<{ completed: boolean; questions: ForensicItem[] } | null> {
  const user = await requireUser();
  const view = await getForensicFor(user.id, String(sessionId));
  return view ? { completed: view.sessionStatus === 'completed', questions: view.questions.map(item) } : null;
}

export async function addForensicQuestionAction(input: { sessionId: string; prompt: string }): Promise<Ok | ActionError> {
  try {
    const user = await requireUser();
    await addForensicQuestionFor(user.id, { sessionId: String(input.sessionId), prompt: String(input.prompt ?? '') });
    touch(String(input.sessionId));
    return { ok: true };
  } catch (e) {
    return failure(e, 'Could not add the question. Try again.');
  }
}

export async function answerForensicQuestionAction(input: { id: string; answer: string }): Promise<Ok | ActionError> {
  try {
    const user = await requireUser();
    await answerForensicQuestionFor(user.id, { id: String(input.id), answer: String(input.answer ?? '') });
    return { ok: true };
  } catch (e) {
    return failure(e, 'Could not save the answer. Try again.');
  }
}

export async function reopenForensicQuestionAction(input: { id: string }): Promise<Ok | ActionError> {
  try {
    const user = await requireUser();
    await reopenForensicQuestionFor(user.id, { id: String(input.id) });
    return { ok: true };
  } catch (e) {
    return failure(e, 'Could not reopen the question. Try again.');
  }
}

// ---- evidence -----------------------------------------------------------------------------------

/** Where the browser should upload an evidence file (validated by type and size first). */
export async function prepareEvidenceUpload(sessionId: string, filename: string, size: number): Promise<Ok<{ target: UploadTarget }> | ActionError> {
  try {
    return { ok: true, target: await createUploadTarget({ kind: 'evidence', sessionId: String(sessionId) }, String(filename), Number(size)) };
  } catch (e) {
    return failure(e, 'Could not start the upload. Try again.');
  }
}

export type EvidenceRecorded = Ok<{ evidenceId: string; reported: number; skipped: number }>;

/**
 * Records evidence: a note, an uploaded file (re-verified for type and actual size; its path must be
 * under the user's prefix and this session's segment), or both. Execution output for a script version
 * on Run hardening script / Targeted remediation also marks that version's requirements Reported.
 */
export async function recordEvidenceAction(input: {
  sessionId: string;
  step: StepKey;
  kind?: EvidenceKind;
  storagePath?: string | null;
  note?: string;
  scriptVersionId?: string | null;
}): Promise<EvidenceRecorded | ActionError> {
  try {
    const user = await requireUser();
    const sessionId = String(input.sessionId);
    const storagePath = input.storagePath ? String(input.storagePath) : null;
    if (storagePath) {
      const parts = storagePath.split('/');
      if (parts[0] !== user.id || parts[1] !== sessionId) throw new ForbiddenFileError();
      await verifyStoredUpload(storagePath, 'evidence');
    }
    const r = await recordEvidenceFor(user.id, {
      sessionId,
      step: input.step,
      kind: input.kind,
      storagePath,
      note: input.note === undefined ? undefined : String(input.note),
      scriptVersionId: input.scriptVersionId ? String(input.scriptVersionId) : null,
    });
    touch(sessionId);
    if (r.reported > 0) revalidatePath('/app', 'layout');
    return { ok: true, evidenceId: r.evidence.id, reported: r.reported, skipped: r.skipped };
  } catch (e) {
    return failure(e, 'Could not save the evidence. Try again.');
  }
}

// ---- points and submission ----------------------------------------------------------------------

export async function recordPointsAction(input: { sessionId: string; score: number; target?: number | null }): Promise<Ok | ActionError> {
  try {
    const user = await requireUser();
    await recordPointsFor(user.id, { sessionId: String(input.sessionId), score: Number(input.score), target: input.target === null || input.target === undefined ? null : Number(input.target) });
    return { ok: true };
  } catch (e) {
    return failure(e, 'Could not record the points. Try again.');
  }
}

export async function submitFinalAction(input: { sessionId: string; overrideForensics?: string }): Promise<Ok | ActionError> {
  try {
    const user = await requireUser();
    await submitFinalFor(user.id, String(input.sessionId), { overrideForensics: input.overrideForensics === undefined ? undefined : String(input.overrideForensics) });
    revalidatePath('/app', 'layout');
    return { ok: true };
  } catch (e) {
    return failure(e, 'Could not submit the session. Try again.');
  }
}
