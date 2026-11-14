import { create } from 'zustand';
import type { ReviewFlag } from './review';

/*
 * Shared state of one proposal's review, so the diff tab and its inspector sections (rendered by the
 * app shell, outside the tab) show the same checklist. Kept in memory per proposal id: ticks survive
 * tab switches (the tab body unmounts) but not a reload, like editor drafts.
 */

export type ReviewEntry = {
  flags: ReviewFlag[];
  acknowledged: string[];
  readOnly: boolean;
  summary: string;
};

type ReviewState = {
  entries: Record<string, ReviewEntry>;
  update: (proposalId: string, patch: Partial<ReviewEntry>) => void;
  toggle: (proposalId: string, flagId: string, checked: boolean) => void;
  clear: (proposalId: string) => void;
};

const EMPTY: ReviewEntry = { flags: [], acknowledged: [], readOnly: true, summary: '' };

export const useProposalReview = create<ReviewState>((set) => ({
  entries: {},
  update: (id, patch) => set((s) => ({ entries: { ...s.entries, [id]: { ...(s.entries[id] ?? EMPTY), ...patch } } })),
  toggle: (id, flagId, checked) =>
    set((s) => {
      const e = s.entries[id] ?? EMPTY;
      if (e.readOnly) return s;
      const rest = e.acknowledged.filter((x) => x !== flagId);
      return { entries: { ...s.entries, [id]: { ...e, acknowledged: checked ? [...rest, flagId] : rest } } };
    }),
  clear: (id) =>
    set((s) => {
      if (!(id in s.entries)) return s;
      const rest = { ...s.entries };
      delete rest[id];
      return { entries: rest };
    }),
}));

/** "Go to line" handlers of mounted diff tabs, by proposal id (not state: functions, set on mount). */
const jumpers = new Map<string, (line: number) => void>();

export function registerJump(proposalId: string, fn: ((line: number) => void) | null) {
  if (fn) jumpers.set(proposalId, fn);
  else jumpers.delete(proposalId);
}

export function jumpTo(proposalId: string, line: number) {
  jumpers.get(proposalId)?.(line);
}
