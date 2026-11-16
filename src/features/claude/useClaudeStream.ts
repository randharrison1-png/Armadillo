'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createSseParser } from '@/lib/sse';
import type { ResourceRef } from '@/lib/types';
import { loadConversation, stopClaudeReply } from './actions';
import type { ChatMessage, ClaudeStreamEvents, ConversationMode } from './types';

const POLL_MS = 2000;
const POLL_MAX = 150; // ~5 minutes: a reply never streams longer than the route's maxDuration

/** RFC 4122 v4 id; crypto.randomUUID only exists on secure origins, getRandomValues everywhere. */
export function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type Active = { requestId: string; controller: AbortController; assistantId: string | null; stoppedByUser: boolean };

export type UseClaudeStream = {
  messages: ChatMessage[];
  /** A request of this view is in flight. */
  streaming: boolean;
  send: (text: string, refs: ResourceRef[]) => void;
  /** Re-sends a prompt with its original clientRequestId (no duplicate user message). */
  retry: (requestId: string) => void;
  stop: () => void;
};

/**
 * Chat state for one conversation and the streaming POST to /api/claude/messages.
 *
 * - send: shows the prompt at once (optimistic) with an empty streaming reply, then fills the reply
 *   from SSE deltas. The prompt is saved server-side before Claude is called, so it is never lost.
 * - Retry resends the SAME clientRequestId: the server finds the saved prompt and re-runs (or
 *   replays) the reply instead of inserting another user message.
 * - stop: marks the reply stopped on the server (which aborts Claude and keeps the partial text)
 *   and aborts the fetch.
 * - Leaving the view (unmount) only aborts the fetch: the server finishes and saves the reply,
 *   and replies still streaming when a conversation is opened are polled until they settle.
 */
export function useClaudeStream(opts: {
  sessionId: string;
  conversationId: string | null;
  mode: ConversationMode;
  initialMessages: ChatMessage[];
  onConversationCreated?: (conversationId: string) => void;
}): UseClaudeStream {
  const { sessionId, mode } = opts;
  const [messages, setMessages] = useState<ChatMessage[]>(opts.initialMessages);
  const [streaming, setStreaming] = useState(false);
  const conversationRef = useRef<string | null>(opts.conversationId);
  const activeRef = useRef<Active | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const onCreatedRef = useRef(opts.onConversationCreated);
  onCreatedRef.current = opts.onConversationCreated;

  const patchReply = useCallback((requestId: string, patch: (m: ChatMessage) => ChatMessage) => {
    setMessages((ms) => ms.map((m) => (m.role === 'assistant' && m.requestId === requestId ? patch(m) : m)));
  }, []);

  const run = useCallback(
    async (requestId: string, text: string, refs: ResourceRef[]) => {
      const active: Active = { requestId, controller: new AbortController(), assistantId: null, stoppedByUser: false };
      activeRef.current = active;
      setStreaming(true);
      let settled = false;
      const fail = (message: string, code: string) => {
        settled = true;
        patchReply(requestId, (m) => ({ ...m, status: 'error', errorMessage: message, errorCode: code }));
      };
      try {
        const res = await fetch('/api/claude/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: conversationRef.current, sessionId, text, refs, mode, clientRequestId: requestId }),
          signal: active.controller.signal,
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
          fail(body?.error ?? 'Could not send the message. Retry to try again.', body?.code ?? 'http');
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSseParser(({ event, data }) => {
          if (event === 'start') {
            const d = data as ClaudeStreamEvents['start'];
            active.assistantId = d.assistantMessageId;
            const created = conversationRef.current === null;
            conversationRef.current = d.conversationId;
            setMessages((ms) =>
              ms.map((m) => {
                if (m.requestId !== requestId) return m;
                if (m.role === 'user') return { ...m, id: d.userMessageId, local: false };
                return { ...m, id: d.assistantMessageId, local: false, ...(d.replay ? { content: '' } : {}) };
              }),
            );
            if (created) onCreatedRef.current?.(d.conversationId);
          } else if (event === 'delta') {
            const d = data as ClaudeStreamEvents['delta'];
            patchReply(requestId, (m) => ({ ...m, content: m.content + d.text }));
          } else if (event === 'done') {
            settled = true;
            const d = data as ClaudeStreamEvents['done'];
            patchReply(requestId, (m) => ({ ...m, status: 'complete', errorCode: undefined, errorMessage: undefined, stopped: undefined, trimmed: d.trimmed?.length ? d.trimmed : undefined }));
          } else if (event === 'error') {
            const d = data as ClaudeStreamEvents['error'];
            if (d.code === 'stopped') {
              settled = true;
              patchReply(requestId, (m) => ({ ...m, status: 'error', stopped: true, errorCode: 'stopped' }));
            } else {
              fail(d.message, d.code);
            }
          }
        });
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.end();
        if (!settled) fail('The connection closed before the reply finished. Retry to try again.', 'interrupted');
      } catch {
        if (active.stoppedByUser) {
          patchReply(requestId, (m) => ({ ...m, status: 'error', stopped: true, errorCode: 'stopped' }));
        } else if (!active.controller.signal.aborted) {
          fail('Connection lost. Retry to try again.', 'network');
        }
      } finally {
        if (activeRef.current === active) {
          activeRef.current = null;
          setStreaming(false);
        }
      }
    },
    [sessionId, mode, patchReply],
  );

  const send = useCallback(
    (text: string, refs: ResourceRef[]) => {
      if (activeRef.current) return;
      const requestId = newRequestId();
      const now = new Date().toISOString();
      const sentRefs = refs.map((r) => ({ type: r.type, id: r.id }));
      setMessages((ms) => [
        ...ms,
        { id: `local-user-${requestId}`, role: 'user', content: text, refs: sentRefs, status: 'complete', requestId, createdAt: now, local: true },
        { id: `local-reply-${requestId}`, role: 'assistant', content: '', refs: [], status: 'streaming', requestId, createdAt: now, local: true },
      ]);
      void run(requestId, text, sentRefs);
    },
    [run],
  );

  const retry = useCallback(
    (requestId: string) => {
      if (activeRef.current) return;
      const prompt = messagesRef.current.find((m) => m.role === 'user' && m.requestId === requestId);
      if (!prompt) return;
      setMessages((ms) => {
        const reset = (m: ChatMessage): ChatMessage => ({ ...m, content: '', status: 'streaming', stopped: undefined, errorCode: undefined, errorMessage: undefined });
        if (ms.some((m) => m.role === 'assistant' && m.requestId === requestId)) {
          return ms.map((m) => (m.role === 'assistant' && m.requestId === requestId ? reset(m) : m));
        }
        const at = ms.indexOf(prompt) + 1;
        const reply: ChatMessage = { id: `local-reply-${requestId}`, role: 'assistant', content: '', refs: [], status: 'streaming', requestId, createdAt: prompt.createdAt, local: true };
        return [...ms.slice(0, at), reply, ...ms.slice(at)];
      });
      void run(requestId, prompt.content, prompt.refs);
    },
    [run],
  );

  const stop = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    active.stoppedByUser = true;
    if (active.assistantId) void stopClaudeReply(active.assistantId).catch(() => undefined);
    active.controller.abort();
    patchReply(active.requestId, (m) => ({ ...m, status: 'error', stopped: true, errorCode: 'stopped' }));
  }, [patchReply]);

  // Leaving the view: abort the fetch only. The server keeps going and saves the reply.
  useEffect(() => () => activeRef.current?.controller.abort(), []);

  // Replies streaming in another request (another tab, or a view left mid-reply): poll until they settle.
  const detached = !streaming && messages.some((m) => m.status === 'streaming' && !m.local);
  useEffect(() => {
    const id = conversationRef.current;
    if (!detached || !id) return;
    let polls = 0;
    let cancelled = false;
    const timer = setInterval(() => {
      if (++polls > POLL_MAX) return clearInterval(timer);
      loadConversation(id).then(
        (r) => {
          if (!cancelled && r && !activeRef.current) setMessages(r.messages);
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [detached]);

  return { messages, streaming, send, retry, stop };
}
