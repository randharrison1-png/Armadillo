'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, FileWarning } from 'lucide-react';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { ErrorState } from '@/components/shell/states/ErrorState';
import { LoadingState } from '@/components/shell/states/LoadingState';
import { Button } from '@/components/ui/button';
import { OS_LABEL } from '@/features/sessions/schema';
import type { Segment, TabDescriptor } from '@/lib/types';
import { cn } from '@/lib/utils';
import { loadReadmeView, type ReadmeView } from './actions';
import { segmentDomId, useReadmeUi } from './readmeUi';

/** Shown verbatim when a PDF has no text layer. */
export const NO_TEXT_MESSAGE = 'No extractable text — paste the README instead';

const HIGHLIGHT_MS = 2000;

const dateLabel = (d: Date) => `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(d)} UTC`;

type Load = { state: 'loading' } | { state: 'error' } | { state: 'missing' } | { state: 'ready'; view: ReadmeView };

/**
 * Body of a 'readme' workspace tab. Shows the README given by `tab.resourceId`, else the session's
 * latest. Text is rendered as plain text (never markdown or HTML), so untrusted README content
 * cannot inject markup. Every segment has id `seg-<segment.id>`; see openSegment in readmeUi.ts.
 */
export function ReadmeTab({ namespace: sessionId, tab }: { namespace: string; tab: TabDescriptor }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const version = useReadmeUi((s) => s.version[sessionId] ?? 0);
  const pending = useReadmeUi((s) => s.pending[sessionId]);
  const consumeSegment = useReadmeUi((s) => s.consumeSegment);
  const openIntake = useReadmeUi((s) => s.openIntake);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lit = useRef<HTMLElement | null>(null);
  const hashHandled = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadReadmeView(sessionId, tab.resourceId).then(
      (view) => !cancelled && setLoad(view ? { state: 'ready', view } : { state: 'missing' }),
      () => !cancelled && setLoad({ state: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, tab.resourceId, version, attempt]);

  const clearHighlight = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    lit.current?.removeAttribute('data-highlight');
    lit.current = null;
  }, []);
  useEffect(() => clearHighlight, [clearHighlight]);

  const reveal = useCallback((segmentId: string): boolean => {
    const el = document.getElementById(segmentDomId(segmentId));
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    // Imperative on purpose: the highlight is transient DOM state, not something React renders.
    clearHighlight();
    el.setAttribute('data-highlight', 'true');
    lit.current = el;
    timer.current = setTimeout(clearHighlight, HIGHLIGHT_MS);
    return true;
  }, [clearHighlight]);

  const ready = load.state === 'ready' ? load.view : null;
  const segments = ready?.readme?.segments;

  // A queued openSegment request, or a #seg-... URL hash, once the segments are in the DOM.
  useEffect(() => {
    if (!segments) return;
    if (pending) {
      reveal(pending.segmentId);
      consumeSegment(sessionId);
      return;
    }
    // A #seg-... URL hash applies once per mounted README view, not on every later re-run.
    if (hashHandled.current) return;
    hashHandled.current = true;
    const hash = window.location.hash;
    if (!hash.startsWith('#seg-')) return;
    let id: string;
    try {
      id = decodeURIComponent(hash.slice('#seg-'.length));
    } catch {
      return;
    }
    if (segments.some((s) => s.id === id)) reveal(id);
  }, [segments, pending, reveal, consumeSegment, sessionId]);

  if (load.state === 'loading') return <LoadingState label="Loading README" />;
  if (load.state === 'error') return <ErrorState title="Could not load the README" detail="Check your connection and try again." onRetry={() => (setLoad({ state: 'loading' }), setAttempt((n) => n + 1))} />;
  if (load.state === 'missing' || !ready) return <EmptyState icon={FileText} title="README not found" description="This session or README no longer exists." />;

  const completed = ready.sessionStatus === 'completed';
  const readme = ready.readme;

  if (!readme) {
    return (
      <EmptyState
        icon={FileText}
        title="No README yet"
        description={completed ? 'This session is completed, so a README can no longer be added.' : 'Add the README that came with the image. It stays with this session.'}
        actions={
          completed ? null : (
            <>
              <Button onClick={() => openIntake(sessionId, 'paste')}>Paste README</Button>
              <Button variant="secondary" onClick={() => openIntake(sessionId, 'upload')}>
                Upload README
              </Button>
            </>
          )
        }
      />
    );
  }

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-4 p-4" aria-label="README">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
        <p className="flex flex-wrap items-baseline gap-x-2 text-small text-muted">
          <span className="text-text">{OS_LABEL[ready.os]}</span>
          <span aria-hidden>·</span>
          <span>{readme.source === 'upload' ? (readme.filename ?? 'Uploaded file') : 'Pasted'}</span>
          <span aria-hidden>·</span>
          <span>{dateLabel(readme.created_at)}</span>
        </p>
        {completed ? null : (
          <Button variant="secondary" onClick={() => openIntake(sessionId, 'paste')}>
            Add README
          </Button>
        )}
      </header>
      {!readme.has_text_layer ? (
        <div role="status" className="flex flex-col items-start gap-2 rounded-sm border border-border bg-surface p-4">
          <p className="flex items-center gap-2 text-body text-text">
            <FileWarning aria-hidden className="size-4 shrink-0 text-warning" />
            {NO_TEXT_MESSAGE}
          </p>
          <p className="text-small text-muted">This PDF looks like a scan, so there is no text to read.</p>
          {completed ? null : <Button onClick={() => openIntake(sessionId, 'paste')}>Paste README</Button>}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {readme.segments.map((seg) => (
            <SegmentBlock key={seg.id} segment={seg} />
          ))}
        </div>
      )}
    </article>
  );
}

function SegmentBlock({ segment }: { segment: Segment }) {
  const ring = 'scroll-mt-4 rounded-sm outline-0 outline-offset-4 data-highlight:outline-2 data-highlight:outline-accent';
  if (segment.kind === 'page') {
    return (
      <section id={segmentDomId(segment.id)} aria-label={`Page ${segment.index}`} className={ring}>
        <h3 className="mb-2 border-b border-border pb-1 text-small font-semibold text-muted">Page {segment.index}</h3>
        <p className="whitespace-pre-wrap break-words text-body text-text">{segment.text || <span className="text-muted">(no text on this page)</span>}</p>
      </section>
    );
  }
  return (
    <p id={segmentDomId(segment.id)} className={cn(ring, 'whitespace-pre-wrap break-words text-body text-text')}>
      {segment.text}
    </p>
  );
}
