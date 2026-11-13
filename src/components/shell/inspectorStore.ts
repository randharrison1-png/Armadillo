'use client';

import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { InspectorSection } from '@/components/shell/Inspector';

type InspectorState = {
  open: boolean;
  sections: InspectorSection[];
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setSections: (sections: InspectorSection[]) => void;
};

export const useInspectorStore = create<InspectorState>((set) => ({
  open: false,
  sections: [],
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  setSections: (sections) => set({ sections }),
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
