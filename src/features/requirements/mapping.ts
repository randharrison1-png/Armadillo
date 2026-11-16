import { markerSegmentId } from '@/server/claude/documents';
import type { AssessedCoverage, AssessmentItem, ExtractedRequirement } from '@/server/claude/schemas';

/**
 * Pure mapping from Claude's structured answers to requirement rows (no I/O, so the rules are
 * unit-tested directly).
 */

/**
 * Keeps the extracted requirements that cite a segment of the README and drops (and counts) the
 * rest. Claude cites segments as written in the markers (markerSegmentId form), either bare
 * (`p-3-1a2b3c4d`) or as the full marker of THIS request (`[seg-<nonce> p-3-1a2b3c4d]`). Kept items
 * carry the README's real segment id, so links open the right element.
 */
export function resolveExtracted(
  items: readonly ExtractedRequirement[],
  segmentIds: readonly string[],
  nonce: string,
): { kept: ExtractedRequirement[]; dropped: number } {
  const real = new Map<string, string>();
  for (const id of segmentIds) {
    const cited = markerSegmentId(id);
    if (cited && !real.has(cited)) real.set(cited, id);
  }
  const marker = new RegExp(`^\\[seg-${nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ([A-Za-z0-9_-]{1,64})\\]$`);
  const kept: ExtractedRequirement[] = [];
  let dropped = 0;
  for (const item of items) {
    const raw = item.segment_id.trim();
    const cited = raw.startsWith('[') ? (marker.exec(raw)?.[1] ?? '') : raw;
    const id = cited ? real.get(cited) : undefined;
    if (id === undefined) dropped++;
    else kept.push({ ...item, segment_id: id });
  }
  return { kept, dropped };
}

/**
 * Spec §5.3: already handled → covered; missing → missing; not safely automatable → manual (a
 * manual task). "Potentially disruptive → require explicit review" is NOT a coverage value: it is
 * the sticky `disruptive` flag plus the user's explicit review (reviewed_at), so a disruptive
 * requirement the script handles stays covered and can be reported once reviewed.
 */
export function coverageFor(a: { coverage: AssessedCoverage; disruptive: boolean; automatable: boolean }): AssessedCoverage {
  if (a.coverage === 'manual' || !a.automatable) return 'manual';
  return a.coverage;
}

export type CoverageUpdate = { coverage: AssessedCoverage; suggestion: string | null; disruptive: boolean; automatable: boolean };

/**
 * Maps assessments (keyed by the short requirement keys we listed, e.g. R3; case-insensitive) to
 * updates by requirement id. Unknown keys and repeats of a key already seen are ignored and
 * counted. A suggestion is kept only where there is something to change (missing) or to review
 * (disruptive). `disruptive` here is this assessment's opinion; the stored flag is sticky (OR).
 */
export function resolveAssessments(
  items: readonly AssessmentItem[],
  keyToId: ReadonlyMap<string, string>,
): { updates: Map<string, CoverageUpdate>; ignored: number } {
  const byKey = new Map([...keyToId].map(([k, id]) => [k.toUpperCase(), id]));
  const updates = new Map<string, CoverageUpdate>();
  let ignored = 0;
  for (const a of items) {
    const id = byKey.get(a.requirement_id.trim().toUpperCase());
    if (id === undefined || updates.has(id)) {
      ignored++;
      continue;
    }
    const coverage = coverageFor(a);
    const suggestion = coverage === 'missing' || a.disruptive ? a.suggestion?.trim() || null : null;
    updates.set(id, { coverage, suggestion, disruptive: a.disruptive, automatable: coverage !== 'manual' && a.automatable });
  }
  return { updates, ignored };
}
