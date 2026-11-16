import { useEffect } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import type { ResourceRef } from '@/lib/types';

/** Resources the user explicitly selected as Claude context for one session (spec: only selected resources are sent). */
export type ContextSelectionState = {
  refs: ResourceRef[];
  add: (ref: ResourceRef) => void;
  remove: (ref: ResourceRef) => void;
  clear: () => void;
  /** Loads persisted refs from localStorage (client only). Safe to call repeatedly. */
  hydrate: () => void;
};

const TYPES: readonly ResourceRef['type'][] = ['readme', 'script_version', 'leads_report', 'evidence'];

const storageKey = (sessionId: string) => `armadillo.context.${sessionId}`;
const same = (a: ResourceRef, b: ResourceRef) => a.type === b.type && a.id === b.id;

function isRef(v: unknown): v is ResourceRef {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && r.id.length > 0 && typeof r.type === 'string' && (TYPES as readonly string[]).includes(r.type);
}

function dedupe(refs: ResourceRef[]): ResourceRef[] {
  const out: ResourceRef[] = [];
  for (const r of refs) if (!out.some((o) => same(o, r))) out.push({ type: r.type, id: r.id });
  return out;
}

function read(sessionId: string): ResourceRef[] {
  try {
    const raw = window.localStorage.getItem(storageKey(sessionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? dedupe(parsed.filter(isRef)) : [];
  } catch {
    return [];
  }
}

function write(sessionId: string, refs: ResourceRef[]) {
  try {
    window.localStorage.setItem(storageKey(sessionId), JSON.stringify(refs));
  } catch {
    // Storage unavailable or full: the selection still works for this page view.
  }
}

function createContextStore(sessionId: string): StoreApi<ContextSelectionState> {
  let hydrated = false;
  return createStore<ContextSelectionState>((set, get) => {
    const ensure = () => {
      if (!hydrated && typeof window !== 'undefined') get().hydrate();
    };
    const commit = (refs: ResourceRef[]) => {
      set({ refs });
      if (typeof window !== 'undefined') write(sessionId, refs);
    };
    return {
      refs: [],
      hydrate: () => {
        if (hydrated || typeof window === 'undefined') return;
        hydrated = true;
        // Keep anything added in memory before hydration (SSR-safe: a pre-mount add is not lost).
        set({ refs: dedupe([...read(sessionId), ...get().refs]) });
      },
      add: (ref) => {
        ensure();
        const { refs } = get();
        if (!refs.some((r) => same(r, ref))) commit([...refs, { type: ref.type, id: ref.id }]);
      },
      remove: (ref) => {
        ensure();
        const { refs } = get();
        if (refs.some((r) => same(r, ref))) commit(refs.filter((r) => !same(r, ref)));
      },
      clear: () => {
        ensure();
        commit([]);
      },
    };
  });
}

const stores = new Map<string, StoreApi<ContextSelectionState>>();

export function getContextStore(sessionId: string): StoreApi<ContextSelectionState> {
  let s = stores.get(sessionId);
  if (!s) {
    s = createContextStore(sessionId);
    stores.set(sessionId, s);
  }
  return s;
}

/** Test helper: drops in-memory stores (localStorage is untouched). */
export function resetContextStores() {
  stores.clear();
}

/** Per-session context selection. Hydrates from localStorage after mount to avoid SSR mismatches. */
export function useContextSelection(sessionId: string): ContextSelectionState {
  const store = getContextStore(sessionId);
  const state = useStore(store);
  useEffect(() => {
    store.getState().hydrate();
  }, [store]);
  return state;
}
