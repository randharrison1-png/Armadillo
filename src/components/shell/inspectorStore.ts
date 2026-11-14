'use client';

import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { InspectorSection } from '@/components/shell/Inspector';

type InspectorState = {
  open: boolean;
  /** The page's sections (SetInspector). */
  sections: InspectorSection[];
  /** Sections of the active workspace tab (SetTabInspector), shown above the page's. */
  tabSections: InspectorSection[];
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setSections: (sections: InspectorSection[]) => void;
  setTabSections: (sections: InspectorSection[]) => void;
};

export const useInspectorStore = create<InspectorState>((set) => ({
  open: false,
  sections: [],
  tabSections: [],
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  setSections: (sections) => set({ sections }),
  setTabSections: (tabSections) => set({ tabSections }),
}));

const signature = (sections: InspectorSection[]) => sections.map((s) => `${s.id}\u0000${s.title}`).join('\u0001');

/**
 * Render inside a page to supply the inspector's sections while it is mounted.
 * Safe with inline (un-memoized) arrays: the store is only written when the section ids/titles
 * change or `version` changes. Pass a new `version` when section content must refresh.
 */
export function SetInspector({ sections, version }: { sections: InspectorSection[]; version?: string | number }) {
  const setSections = useInspectorStore((s) => s.setSections);
  const latest = useRef(sections);
  const sig = signature(sections);
  useEffect(() => {
    latest.current = sections;
  });
  useEffect(() => {
    setSections(latest.current);
  }, [sig, version, setSections]);
  useEffect(() => () => setSections([]), [setSections]);
  return null;
}

/**
 * Like SetInspector, for a workspace tab body: its sections are shown ABOVE the page's while it is
 * mounted (only the active tab's body is mounted) and removed on unmount, leaving the page's intact.
 */
export function SetTabInspector({ sections, version }: { sections: InspectorSection[]; version?: string | number }) {
  const setTabSections = useInspectorStore((s) => s.setTabSections);
  const latest = useRef(sections);
  const sig = signature(sections);
  useEffect(() => {
    latest.current = sections;
  });
  useEffect(() => {
    setTabSections(latest.current);
  }, [sig, version, setTabSections]);
  useEffect(() => () => setTabSections([]), [setTabSections]);
  return null;
}
