import { create } from 'zustand';

/**
 * Unsaved editor text, kept in memory per workspace tab so switching tabs (which unmounts the
 * inactive tab body) or navigating within the app does not lose edits. Not persisted: a reload
 * drops drafts, and WorkspaceTabs warns before unload while any draft is dirty.
 *
 * `pristine` is the text the editor started from (as the editor normalized it); a draft is dirty
 * when `content !== pristine`. `baseVersionId` is the version the edits are based on — saves send
 * it so a stale base is reported as a conflict instead of overwriting.
 */
export type Draft = { baseVersionId: string | null; pristine: string; content: string };

type DraftState = {
  drafts: Record<string, Draft>;
  put: (key: string, draft: Draft) => void;
  clear: (key: string) => void;
};

export const draftKey = (namespace: string, tabKey: string) => `${namespace}\u0000${tabKey}`;

export const isDirty = (d: Draft | undefined): boolean => !!d && d.content !== d.pristine;

export const useDrafts = create<DraftState>((set) => ({
  drafts: {},
  put: (key, draft) => set((s) => ({ drafts: { ...s.drafts, [key]: draft } })),
  clear: (key) =>
    set((s) => {
      if (!(key in s.drafts)) return s;
      const rest = { ...s.drafts };
      delete rest[key];
      return { drafts: rest };
    }),
}));
