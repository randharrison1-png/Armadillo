'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { ScriptEditorData, SessionChoice } from './versionTypes';

/**
 * Extras a page can hand to its script/diff tabs: server-loaded data for the first render (so the
 * library page does not fetch twice) and the sessions a script can be forked into. Session
 * workspaces provide nothing: their tabs load data on demand and offer no fork.
 */
type ScriptEditorExtras = { initial?: ScriptEditorData; forkTargets?: SessionChoice[] };

const Ctx = createContext<ScriptEditorExtras>({});

export function ScriptEditorProvider({ value, children }: { value: ScriptEditorExtras; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useScriptEditorExtras = () => useContext(Ctx);
