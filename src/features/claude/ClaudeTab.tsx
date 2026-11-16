'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Bot, KeyRound, MessageSquarePlus } from 'lucide-react';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { ErrorState } from '@/components/shell/states/ErrorState';
import { LoadingState } from '@/components/shell/states/LoadingState';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { TabDescriptor } from '@/lib/types';
import { loadClaudeTab, loadContextOptions, loadConversation } from './actions';
import { Composer } from './Composer';
import { ContextPicker } from './ContextPicker';
import { consumeClaudeIntent, useClaudeIntent } from './claudeIntent';
import { getContextStore } from './contextSelection';
import { MessageList } from './MessageList';
import { newRequestId, useClaudeStream } from './useClaudeStream';
import { MODE_LABEL, refKey, type ChatMessage, type ClaudeTabData, type ContextOptions, type ConversationMode } from './types';

const MODES: ConversationMode[] = ['general', 'adaptation', 'remediation'];
const NEW = '__new__';

type Load = { state: 'loading' } | { state: 'error' } | { state: 'missing' } | { state: 'ready'; data: ClaudeTabData };
/** `panel` stays the same when a new conversation gets its id, so the streaming view is not remounted. */
type Current = { panel: string; conversationId: string | null; mode: ConversationMode };

const draft = (mode: ConversationMode = 'general'): Current => ({ panel: `draft-${newRequestId()}`, conversationId: null, mode });

/**
 * Body of the pinned Claude tab of a session: pick or start a conversation (each has a mode),
 * read it, choose context, and chat. The Claude key never reaches this component — only whether
 * one is configured.
 */
export function ClaudeTab({ namespace: sessionId }: { namespace: string; tab: TabDescriptor }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [current, setCurrent] = useState<Current | null>(null);
  const [options, setOptions] = useState<ContextOptions | null>(null);
  const [optionsState, setOptionsState] = useState<'idle' | 'loading' | 'error' | 'ready'>('loading');

  useEffect(() => {
    let cancelled = false;
    loadClaudeTab(sessionId).then(
      (data) => {
        if (cancelled) return;
        if (!data) return setLoad({ state: 'missing' });
        setLoad({ state: 'ready', data });
        setCurrent((c) => c ?? (data.conversations[0] ? { panel: data.conversations[0].id, conversationId: data.conversations[0].id, mode: data.conversations[0].mode } : draft()));
      },
      () => !cancelled && setLoad({ state: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, attempt]);

  const optionsSeq = useRef(0);
  const fetchOptions = useCallback(() => {
    const seq = ++optionsSeq.current;
    const store = getContextStore(sessionId);
    store.getState().hydrate(); // read the persisted selection before asking for its labels
    loadContextOptions(sessionId, store.getState().refs).then(
      (o) => {
        if (seq !== optionsSeq.current) return;
        setOptions(o);
        setOptionsState(o ? 'ready' : 'error');
      },
      () => seq === optionsSeq.current && setOptionsState('error'),
    );
  }, [sessionId]);
  const refreshOptions = useCallback(() => {
    setOptionsState('loading');
    fetchOptions();
  }, [fetchOptions]);
  // Load once up front: the labels also name the chips on sent messages.
  useEffect(() => fetchOptions(), [fetchOptions]);

  // A one-shot request from elsewhere (e.g. the flowchart's "Send LEADS report to Claude"): select
  // its resources and work in its mode, reusing the empty draft if that is what is open.
  const hasIntent = useClaudeIntent((s) => !!s.pending[sessionId]);
  const ready = load.state === 'ready' && current !== null;
  useEffect(() => {
    if (!ready || !hasIntent) return;
    const consumed = consumeClaudeIntent(sessionId);
    if (!consumed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- applies a one-shot request from an external store, once
    setCurrent((c) => (c && c.conversationId === null ? { ...c, mode: consumed.mode } : draft(consumed.mode)));
    refreshOptions();
  }, [ready, hasIntent, sessionId, refreshOptions]);

  const labels = useMemo(() => {
    const m = new Map<string, string>();
    if (options) for (const group of Object.values(options)) for (const o of group) m.set(refKey(o.ref), o.label);
    return m;
  }, [options]);

  const onCreated = useCallback(
    (conversationId: string) => {
      setCurrent((c) => (c && c.conversationId === null ? { ...c, conversationId } : c));
      // Refresh the conversation list (title, order) without touching the open view.
      loadClaudeTab(sessionId).then(
        (data) => data && setLoad({ state: 'ready', data }),
        () => undefined,
      );
    },
    [sessionId],
  );

  if (load.state === 'loading' || (load.state === 'ready' && !current)) return <LoadingState label="Loading Claude" />;
  if (load.state === 'error') return <ErrorState title="Could not load Claude" detail="Check your connection and try again." onRetry={() => (setLoad({ state: 'loading' }), setAttempt((n) => n + 1))} />;
  if (load.state === 'missing' || !current) return <EmptyState icon={Bot} title="Session not found" description="This session no longer exists." />;

  const { data } = load;
  const readOnly = data.sessionStatus === 'completed';
  const conversations = data.conversations;
  const known = current.conversationId ? conversations.find((c) => c.id === current.conversationId) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <Select
          value={current.conversationId ?? NEW}
          onValueChange={(v) => {
            if (v === NEW) return;
            const c = conversations.find((x) => x.id === v);
            if (c) setCurrent({ panel: c.id, conversationId: c.id, mode: c.mode });
          }}
        >
          <SelectTrigger aria-label="Conversation" className="w-72 max-w-full [&>span]:truncate [&>span]:text-left">
            <SelectValue placeholder="Conversation" />
          </SelectTrigger>
          <SelectContent>
            {current.conversationId === null ? <SelectItem value={NEW}>New conversation</SelectItem> : null}
            {current.conversationId && !known ? <SelectItem value={current.conversationId}>New conversation</SelectItem> : null}
            {conversations.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {(c.title || 'Untitled') + ` · ${MODE_LABEL[c.mode]}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {current.conversationId === null ? (
          <Select value={current.mode} onValueChange={(v) => setCurrent((c) => (c ? { ...c, mode: v as ConversationMode } : c))}>
            <SelectTrigger aria-label="Mode" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((m) => (
                <SelectItem key={m} value={m}>
                  {MODE_LABEL[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="rounded-sm border border-border px-2 text-small text-muted">Mode: {MODE_LABEL[current.mode]}</span>
        )}
        <Button variant="secondary" className="ml-auto" disabled={readOnly || current.conversationId === null} onClick={() => setCurrent(draft())}>
          <MessageSquarePlus aria-hidden className="size-4" />
          New conversation
        </Button>
      </div>

      {!data.keyConfigured ? (
        <div role="note" className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-4 py-2 text-small text-text">
          <KeyRound aria-hidden className="size-4 shrink-0 text-warning" />
          <span>Add a Claude API key in Settings</span>
          <Link href="/app/settings" className="text-accent underline underline-offset-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            Open Settings
          </Link>
        </div>
      ) : null}

      <ConversationPanel
        key={current.panel}
        sessionId={sessionId}
        conversationId={current.conversationId}
        mode={current.mode}
        readOnly={readOnly}
        labels={labels}
        onCreated={onCreated}
        picker={<ContextPicker sessionId={sessionId} options={options} state={optionsState} disabled={readOnly} onOpen={refreshOptions} />}
      />
    </div>
  );
}

type PanelLoad = { state: 'loading' } | { state: 'error' } | { state: 'ready'; messages: ChatMessage[] };

function ConversationPanel(props: {
  sessionId: string;
  conversationId: string | null;
  mode: ConversationMode;
  readOnly: boolean;
  labels: ReadonlyMap<string, string>;
  onCreated: (id: string) => void;
  picker: ReactNode;
}) {
  // Only the id this panel opened with is loaded; a draft that gets its id keeps its live state.
  const [initialId] = useState(props.conversationId);
  const [load, setLoad] = useState<PanelLoad>(initialId ? { state: 'loading' } : { state: 'ready', messages: [] });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!initialId) return;
    let cancelled = false;
    loadConversation(initialId).then(
      (r) => !cancelled && setLoad(r ? { state: 'ready', messages: r.messages } : { state: 'error' }),
      () => !cancelled && setLoad({ state: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [initialId, attempt]);

  if (load.state === 'loading') return <LoadingState label="Loading conversation" />;
  if (load.state === 'error') {
    return <ErrorState title="Could not load this conversation" detail="Check your connection and try again." onRetry={() => (setLoad({ state: 'loading' }), setAttempt((n) => n + 1))} />;
  }
  return <Chat {...props} conversationId={initialId} initialMessages={load.messages} />;
}

function Chat({
  sessionId,
  conversationId,
  mode,
  readOnly,
  labels,
  onCreated,
  picker,
  initialMessages,
}: {
  sessionId: string;
  conversationId: string | null;
  mode: ConversationMode;
  readOnly: boolean;
  labels: ReadonlyMap<string, string>;
  onCreated: (id: string) => void;
  picker: ReactNode;
  initialMessages: ChatMessage[];
}) {
  const chat = useClaudeStream({ sessionId, conversationId, mode, initialMessages, onConversationCreated: onCreated });
  const send = (text: string) => chat.send(text, getContextStore(sessionId).getState().refs);

  return (
    <>
      <div data-scroll-root className="min-h-0 flex-1 overflow-y-auto">
        {chat.messages.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="Ask Claude about this session"
            description="Claude only sees the items you select under Context below. Your README, scripts and reports stay private until you attach them to a message."
          />
        ) : (
          <MessageList messages={chat.messages} labels={labels} busy={chat.streaming} readOnly={readOnly} onRetry={chat.retry} />
        )}
      </div>
      {picker}
      <Composer
        streaming={chat.streaming}
        disabled={readOnly}
        disabledReason={readOnly ? 'This session is completed and read-only.' : undefined}
        onSend={send}
        onStop={chat.stop}
      />
    </>
  );
}
