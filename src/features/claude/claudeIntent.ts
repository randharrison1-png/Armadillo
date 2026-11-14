import { create } from 'zustand';
import { getContextStore } from './contextSelection';
import type { ConversationMode } from './types';
import type { ResourceRef } from '@/lib/types';

/**
 * A one-shot request to the Claude tab (e.g. from the flowchart's "Send LEADS report to Claude"):
 * select these resources and work in this mode. The tab consumes it once after it loads.
 */
export type ClaudeIntent = { mode: ConversationMode; refs: ResourceRef[] };

type IntentState = {
  pending: Record<string, ClaudeIntent | undefined>;
  request: (sessionId: string, intent: ClaudeIntent) => void;
  take: (sessionId: string) => ClaudeIntent | null;
};

export const useClaudeIntent = create<IntentState>((set, get) => ({
  pending: {},
  request: (sessionId, intent) => set((s) => ({ pending: { ...s.pending, [sessionId]: intent } })),
  take: (sessionId) => {
    const intent = get().pending[sessionId];
    if (!intent) return null;
    set((s) => ({ pending: { ...s.pending, [sessionId]: undefined } }));
    return intent;
  },
}));

export const requestClaudeIntent = (sessionId: string, intent: ClaudeIntent) => useClaudeIntent.getState().request(sessionId, intent);

/** Takes the session's pending intent (once), adds its refs to the context selection, and returns its mode (null when none). */
export function consumeClaudeIntent(sessionId: string): { mode: ConversationMode } | null {
  const intent = useClaudeIntent.getState().take(sessionId);
  if (!intent) return null;
  const store = getContextStore(sessionId).getState();
  for (const ref of intent.refs) store.add(ref);
  return { mode: intent.mode };
}
