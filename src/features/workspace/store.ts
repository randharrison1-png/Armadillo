import { useEffect } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import type { TabDescriptor, TabKind } from '@/lib/types';

/** The Claude conversation tab never closes (spec 3.2: opening resources never closes it). */
export const PINNED_TAB_KEY = 'claude';

const KINDS: readonly TabKind[] = ['claude', 'readme', 'script', 'diff', 'flowchart', 'report', 'requirements'];

const CLAUDE_TAB: TabDescriptor = { key: 'claude', kind: 'claude', title: 'Claude' };
const FLOWCHART_TAB: TabDescriptor = { key: 'flowchart', kind: 'flowchart', title: 'Flowchart' };
const defaultTabs = (): TabDescriptor[] => [{ ...CLAUDE_TAB }, { ...FLOWCHART_TAB }];

export type WorkspaceState = {
  tabs: TabDescriptor[];
  activeKey: string | null;
  openTab: (desc: TabDescriptor) => void;
  closeTab: (key: string) => void;
  activate: (key: string) => void;
  /** Loads persisted tabs from localStorage (client only). Safe to call repeatedly. */
  hydrate: () => void;
};

const storageKey = (sessionId: string) => `armadillo.tabs.${sessionId}`;

function isTab(v: unknown): v is TabDescriptor {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.key === 'string' &&
    t.key.length > 0 &&
    typeof t.title === 'string' &&
    typeof t.kind === 'string' &&
    (KINDS as readonly string[]).includes(t.kind) &&
    (t.resourceId === undefined || typeof t.resourceId === 'string')
  );
}

function read(sessionId: string): { tabs: TabDescriptor[]; activeKey: string } {
  const fallback = { tabs: defaultTabs(), activeKey: PINNED_TAB_KEY };
  try {
    const raw = window.localStorage.getItem(storageKey(sessionId));
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const { tabs, activeKey } = parsed as { tabs?: unknown; activeKey?: unknown };
    if (!Array.isArray(tabs) || tabs.length === 0 || !tabs.every(isTab)) return fallback;
    const seen = new Set<string>();
    const unique = tabs.filter((t) => !seen.has(t.key) && (seen.add(t.key), true));
    if (!seen.has(PINNED_TAB_KEY)) unique.unshift({ ...CLAUDE_TAB });
    const active = typeof activeKey === 'string' && seen.has(activeKey) ? activeKey : PINNED_TAB_KEY;
    return { tabs: unique, activeKey: active };
  } catch {
    return fallback;
  }
}

function write(sessionId: string, s: Pick<WorkspaceState, 'tabs' | 'activeKey'>) {
  try {
    window.localStorage.setItem(storageKey(sessionId), JSON.stringify({ tabs: s.tabs, activeKey: s.activeKey }));
  } catch {
    // Storage unavailable or full: tabs still work for this page view.
  }
}

function createWorkspaceStore(sessionId: string): StoreApi<WorkspaceState> {
  let hydrated = false;
  return createStore<WorkspaceState>((set, get) => {
    const ensure = () => {
      if (!hydrated && typeof window !== 'undefined') get().hydrate();
    };
    const commit = (next: Pick<WorkspaceState, 'tabs' | 'activeKey'>) => {
      set(next);
      if (typeof window !== 'undefined') write(sessionId, next);
    };
    return {
      ...{ tabs: defaultTabs(), activeKey: PINNED_TAB_KEY },
      hydrate: () => {
        if (hydrated || typeof window === 'undefined') return;
        hydrated = true;
        set(read(sessionId));
      },
      openTab: (desc) => {
        ensure();
        const { tabs } = get();
        commit(tabs.some((t) => t.key === desc.key) ? { tabs, activeKey: desc.key } : { tabs: [...tabs, desc], activeKey: desc.key });
      },
      closeTab: (key) => {
        ensure();
        if (key === PINNED_TAB_KEY) return;
        const { tabs, activeKey } = get();
        const i = tabs.findIndex((t) => t.key === key);
        if (i < 0) return;
        const next = tabs.filter((t) => t.key !== key);
        let nextActive = activeKey;
        if (activeKey === key) nextActive = (next[i] ?? next[i - 1] ?? null)?.key ?? null;
        commit({ tabs: next, activeKey: nextActive });
      },
      activate: (key) => {
        ensure();
        const { tabs, activeKey } = get();
        if (tabs.some((t) => t.key === key) && key !== activeKey) commit({ tabs, activeKey: key });
      },
    };
  });
}

const stores = new Map<string, StoreApi<WorkspaceState>>();

export function getWorkspaceStore(sessionId: string): StoreApi<WorkspaceState> {
  let s = stores.get(sessionId);
  if (!s) {
    s = createWorkspaceStore(sessionId);
    stores.set(sessionId, s);
  }
  return s;
}

/** Test helper: drops in-memory stores (localStorage is untouched). */
export function resetWorkspaceStores() {
  stores.clear();
}

/** Per-session tab state. Hydrates from localStorage after mount to avoid SSR mismatches. */
export function useWorkspace(sessionId: string): WorkspaceState {
  const store = getWorkspaceStore(sessionId);
  const state = useStore(store);
  useEffect(() => {
    store.getState().hydrate();
  }, [store]);
  return state;
}
