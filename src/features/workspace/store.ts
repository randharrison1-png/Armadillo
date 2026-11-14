import { useEffect } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import type { TabDescriptor, TabKind } from '@/lib/types';

/** The Claude conversation tab never closes (spec 3.2: opening resources never closes it). */
export const PINNED_TAB_KEY = 'claude';

const KINDS: readonly TabKind[] = ['claude', 'readme', 'script', 'diff', 'flowchart', 'report', 'requirements'];

const CLAUDE_TAB: TabDescriptor = { key: 'claude', kind: 'claude', title: 'Claude' };
const FLOWCHART_TAB: TabDescriptor = { key: 'flowchart', kind: 'flowchart', title: 'Flowchart' };

/**
 * What a workspace starts with. `pinned` is the one tab that can never close (and is restored if a
 * persisted list lost it); it must be one of `defaults()`.
 */
export type WorkspaceConfig = { defaults: () => TabDescriptor[]; pinned: string };

/** Session workspaces (the default): Claude (pinned) + Flowchart. */
export const SESSION_WORKSPACE: WorkspaceConfig = {
  defaults: () => [{ ...CLAUDE_TAB }, { ...FLOWCHART_TAB }],
  pinned: PINNED_TAB_KEY,
};

/**
 * The tab strip on /app/library/[scriptId] (outside any session): namespace `library:<scriptId>`,
 * starting with (and pinning) that script's editor tab instead of Claude/Flowchart.
 */
export function libraryWorkspace(editorTab: TabDescriptor): WorkspaceConfig & { namespace: string } {
  return { namespace: `library:${editorTab.resourceId ?? editorTab.key}`, defaults: () => [{ ...editorTab }], pinned: editorTab.key };
}

export type WorkspaceState = {
  tabs: TabDescriptor[];
  activeKey: string | null;
  openTab: (desc: TabDescriptor) => void;
  closeTab: (key: string) => void;
  activate: (key: string) => void;
  /** Loads persisted tabs from localStorage (client only). Safe to call repeatedly. */
  hydrate: () => void;
};

/** Session workspaces use the session id as namespace, so their key stays `armadillo.tabs.{sessionId}`. */
const storageKey = (namespace: string) => `armadillo.tabs.${namespace}`;

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

function read(namespace: string, config: WorkspaceConfig): { tabs: TabDescriptor[]; activeKey: string } {
  const fallback = { tabs: config.defaults(), activeKey: config.pinned };
  try {
    const raw = window.localStorage.getItem(storageKey(namespace));
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const { tabs, activeKey } = parsed as { tabs?: unknown; activeKey?: unknown };
    if (!Array.isArray(tabs) || tabs.length === 0 || !tabs.every(isTab)) return fallback;
    const seen = new Set<string>();
    const unique = tabs.filter((t) => !seen.has(t.key) && (seen.add(t.key), true));
    if (!seen.has(config.pinned)) {
      const pinned = config.defaults().find((t) => t.key === config.pinned);
      if (pinned) unique.unshift(pinned);
    }
    const active = typeof activeKey === 'string' && seen.has(activeKey) ? activeKey : config.pinned;
    return { tabs: unique, activeKey: active };
  } catch {
    return fallback;
  }
}

function write(namespace: string, s: Pick<WorkspaceState, 'tabs' | 'activeKey'>) {
  try {
    window.localStorage.setItem(storageKey(namespace), JSON.stringify({ tabs: s.tabs, activeKey: s.activeKey }));
  } catch {
    // Storage unavailable or full: tabs still work for this page view.
  }
}

function createWorkspaceStore(namespace: string, config: WorkspaceConfig): StoreApi<WorkspaceState> {
  let hydrated = false;
  return createStore<WorkspaceState>((set, get) => {
    const ensure = () => {
      if (!hydrated && typeof window !== 'undefined') get().hydrate();
    };
    const commit = (next: Pick<WorkspaceState, 'tabs' | 'activeKey'>) => {
      set(next);
      if (typeof window !== 'undefined') write(namespace, next);
    };
    return {
      tabs: config.defaults(),
      activeKey: config.pinned,
      hydrate: () => {
        if (hydrated || typeof window === 'undefined') return;
        hydrated = true;
        set(read(namespace, config));
      },
      openTab: (desc) => {
        ensure();
        const { tabs } = get();
        commit(tabs.some((t) => t.key === desc.key) ? { tabs, activeKey: desc.key } : { tabs: [...tabs, desc], activeKey: desc.key });
      },
      closeTab: (key) => {
        ensure();
        if (key === config.pinned) return;
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

/**
 * The tab store for a namespace (a session id, or `library:<scriptId>`). `config` only applies
 * when the store is first created; later calls return the same store.
 */
export function getWorkspaceStore(namespace: string, config: WorkspaceConfig = SESSION_WORKSPACE): StoreApi<WorkspaceState> {
  let s = stores.get(namespace);
  if (!s) {
    s = createWorkspaceStore(namespace, config);
    stores.set(namespace, s);
  }
  return s;
}

/** Test helper: drops in-memory stores (localStorage is untouched). */
export function resetWorkspaceStores() {
  stores.clear();
}

/** Per-namespace tab state. Hydrates from localStorage after mount to avoid SSR mismatches. */
export function useWorkspace(namespace: string, config?: WorkspaceConfig): WorkspaceState {
  const store = getWorkspaceStore(namespace, config);
  const state = useStore(store);
  useEffect(() => {
    store.getState().hydrate();
  }, [store]);
  return state;
}
