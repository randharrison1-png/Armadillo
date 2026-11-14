'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { AlertTriangle, FileText, ListChecks, Paperclip, RotateCcw, ScrollText, Square, Terminal, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ResourceRef } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Markdown } from './Markdown';
import { REF_TYPE_LABEL, refKey, type ChatMessage } from './types';

const REF_ICON: Record<ResourceRef['type'], LucideIcon> = {
  readme: FileText,
  script_version: Terminal,
  leads_report: ScrollText,
  evidence: ListChecks,
};

/** User-facing text for a failed reply loaded from the server (only its code is stored). */
const ERROR_TEXT: Record<string, string> = {
  no_key: 'Add a Claude API key in Settings',
  key_unreadable: 'Your saved Claude API key could not be read. Save it again in Settings.',
  overloaded: 'Claude was overloaded and the reply did not finish.',
  rate_limited: 'Claude was rate-limiting requests and the reply did not finish.',
  interrupted: 'This reply did not finish.',
  auth: 'Claude rejected the API key. Check it in Settings.',
};

function errorText(m: ChatMessage): string {
  if (m.stopped || m.errorCode === 'stopped') return 'Stopped.';
  return m.errorMessage ?? (m.errorCode && ERROR_TEXT[m.errorCode]) ?? 'This reply failed.';
}

export function RefChips({ refs, labels }: { refs: ResourceRef[]; labels: ReadonlyMap<string, string> }) {
  if (refs.length === 0) return null;
  return (
    <ul aria-label="Attached context" className="flex flex-wrap justify-end gap-1">
      {refs.map((r) => {
        const Icon = REF_ICON[r.type] ?? Paperclip;
        return (
          <li key={refKey(r)} className="flex max-w-64 items-center gap-1 rounded-sm border border-border bg-bg px-2 text-small text-muted">
            <Icon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{labels.get(refKey(r)) ?? REF_TYPE_LABEL[r.type]}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Thinking() {
  return (
    <span role="status" className="flex items-center gap-1 font-mono text-small text-muted">
      <span className="sr-only">Claude is thinking</span>
      <span aria-hidden className="animate-pulse motion-reduce:animate-none">
        ···
      </span>
    </span>
  );
}

/**
 * The conversation. User text is plain text (never markup); Claude's replies are safe Markdown.
 * A failed or stopped reply keeps its partial text and offers Retry.
 */
export function MessageList({
  messages,
  labels,
  busy,
  readOnly,
  onRetry,
}: {
  messages: ChatMessage[];
  labels: ReadonlyMap<string, string>;
  /** A request is in flight (Retry is disabled meanwhile). */
  busy: boolean;
  readOnly: boolean;
  onRetry: (requestId: string) => void;
}) {
  const end = useRef<HTMLLIElement>(null);
  const last = messages.at(-1);
  const lastLength = last?.content.length ?? 0;
  useEffect(() => {
    const el = end.current;
    const box = el?.closest('[data-scroll-root]');
    if (!el || !box) return;
    // Follow the stream only while the reader is at (or near) the bottom.
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) el.scrollIntoView({ block: 'end' });
  }, [messages.length, lastLength]);

  return (
    <ol aria-label="Conversation" className="flex flex-col gap-4 p-4">
      {messages.map((m) =>
        m.role === 'user' ? (
          <li key={m.id} className="flex flex-col items-end gap-1">
            <span className="sr-only">You:</span>
            <div className="max-w-[85%] rounded-md bg-surface-raised px-4 py-2 text-body whitespace-pre-wrap break-words text-text">{m.content}</div>
            <RefChips refs={m.refs} labels={labels} />
          </li>
        ) : (
          <li key={m.id} aria-busy={m.status === 'streaming' || undefined} className="flex flex-col gap-2">
            <span className="sr-only">Claude:</span>
            {m.content ? <Markdown>{m.content}</Markdown> : m.status === 'streaming' ? <Thinking /> : null}
            {m.status === 'streaming' && m.content ? <span className="sr-only">Claude is still writing</span> : null}
            {m.status === 'streaming' && !m.local && !busy ? (
              <p className="text-small text-muted">Claude is still answering. This updates when the reply is saved.</p>
            ) : null}
            {m.status === 'error' ? (
              <div
                role={m.stopped || m.errorCode === 'stopped' ? 'status' : 'alert'}
                className={cn(
                  'flex flex-wrap items-center gap-2 rounded-sm border px-2 py-1 text-small',
                  m.stopped || m.errorCode === 'stopped' ? 'border-border text-muted' : 'border-danger text-text',
                )}
              >
                {m.stopped || m.errorCode === 'stopped' ? (
                  <Square aria-hidden className="size-4 shrink-0" />
                ) : (
                  <AlertTriangle aria-hidden className="size-4 shrink-0 text-danger" />
                )}
                <span>{errorText(m)}</span>
                {m.errorCode === 'no_key' || m.errorCode === 'auth' || m.errorCode === 'key_unreadable' ? (
                  <Link href="/app/settings" className="text-accent underline underline-offset-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    Open Settings
                  </Link>
                ) : null}
                {m.requestId && !readOnly ? (
                  <Button variant="secondary" className="ml-auto h-control-sm" disabled={busy} onClick={() => onRetry(m.requestId!)}>
                    <RotateCcw aria-hidden className="size-4" />
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        ),
      )}
      <li ref={end} aria-hidden className="h-px" />
    </ol>
  );
}
