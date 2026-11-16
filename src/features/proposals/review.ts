import type { HighImpactFlag, ScriptLanguage, TabDescriptor } from '@/lib/types';
import { requiredFlags } from '@/lib/highImpact';

/*
 * Client-safe review helpers for proposal diff tabs (no server imports): the checklist the tab shows
 * is computed with the same functions the server applies at accept time (highImpact.ts), so what the
 * user ticks is exactly what acceptProposal requires.
 */

/** A flag in the review checklist: from the stored proposal, or found by re-scanning the user's edits. */
export type ReviewFlag = HighImpactFlag & { origin: 'proposal' | 'edit' };

export function reviewFlags(stored: readonly HighImpactFlag[], content: string, language: ScriptLanguage): ReviewFlag[] {
  const storedIds = new Set(stored.map((f) => f.id));
  return requiredFlags(stored, content, language).map((f) => ({ ...f, origin: storedIds.has(f.id) ? 'proposal' : 'edit' }));
}

export function acceptLabel(acknowledged: number, total: number): string {
  return total === 0 ? 'Accept' : `Accept (${acknowledged} of ${total} acknowledged)`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The diff tab of a proposal: kind 'diff', resourceId `proposal:<proposalId>`, key
 * `diff:proposal:<proposalId>` (version comparisons use `<scriptId>:<from>..<to>`, see scriptTabs.ts).
 */
export function proposalTab(proposalId: string, filename: string): TabDescriptor {
  return { key: `diff:proposal:${proposalId}`, kind: 'diff', title: `${filename} · proposal`, resourceId: `proposal:${proposalId}` };
}

export function parseProposalResourceId(resourceId: string): string | null {
  if (!resourceId.startsWith('proposal:')) return null;
  const id = resourceId.slice('proposal:'.length);
  return UUID.test(id) ? id : null;
}
