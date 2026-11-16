'use client';

import { create } from 'zustand';

/**
 * Forensic panels can be on screen twice (the session inspector and the flowchart's forensic node)
 * and the flowchart's submit panel shows the counts. A bump after any change makes all of them reload.
 */
type State = { version: Record<string, number | undefined>; bump: (sessionId: string) => void };

export const useForensicSync = create<State>((set) => ({
  version: {},
  bump: (sessionId) => set((s) => ({ version: { ...s.version, [sessionId]: (s.version[sessionId] ?? 0) + 1 } })),
}));
