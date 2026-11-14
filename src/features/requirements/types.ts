// Client-safe types for the requirements matrix (no runtime code).
import type { Coverage, WorkState } from '@/lib/types';

/** One matrix row: a requirement with its README position and the labels it links to. */
export type RequirementRow = {
  id: string;
  readmeId: string;
  text: string;
  /** Segment.id in the README (stable; the README tab's element id is `seg-<segmentId>`). */
  segmentId: string;
  /** Where the segment sits; null if the README no longer has it. Paragraph indexes are 0-based, pages 1-based. */
  sourceKind: 'paragraph' | 'page' | null;
  sourceIndex: number | null;
  category: string | null;
  coverage: Coverage;
  workState: WorkState;
  disruptive: boolean;
  automatable: boolean;
  /** Claude's suggested change (last assessment). */
  suggestion: string | null;
  /** The user's notes. */
  notes: string | null;
  scriptVersionId: string | null;
  /** e.g. "Guest hardening · v2". */
  scriptLabel: string | null;
  evidenceReportId: string | null;
  /** e.g. "leads.txt · cycle 1" (the verification evidence). */
  evidenceLabel: string | null;
};

export type ReadmeOption = { id: string; label: string; hasText: boolean };
export type ScriptVersionOption = { id: string; label: string; scope: 'session' | 'library' };

export type RequirementsView = {
  sessionStatus: 'active' | 'completed';
  /** Newest first. */
  readmes: ReadmeOption[];
  scriptOptions: ScriptVersionOption[];
  /** Matrix order: oldest first (extraction order). */
  requirements: RequirementRow[];
};

export type ActionError = { ok: false; error: string };
export type ExtractOutcome = { ok: true; inserted: number; dropped: number; replaced: number; kept: number; trimmed: boolean };
export type AssessOutcome = { ok: true; assessed: number; ignored: number; unassessed: number; skipped: number; trimmed: boolean; scriptLabel: string };
export type NotesOutcome = { ok: true; notes: string | null };
