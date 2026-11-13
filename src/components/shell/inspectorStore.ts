'use client';

import { useEffect } from 'react';
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

/** Render inside a page to supply the inspector's sections while it is mounted (memoize `sections`). */
export function SetInspector({ sections }: { sections: InspectorSection[] }) {
  const setSections = useInspectorStore((s) => s.setSections);
  useEffect(() => {
    setSections(sections);
    return () => setSections([]);
  }, [sections, setSections]);
  return null;
}
