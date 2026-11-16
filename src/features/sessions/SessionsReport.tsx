import Link from 'next/link';
import { ArrowRight, ChevronRight, Download, FileText, Paperclip, Wrench } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { STEP_LABEL } from '@/features/flowchart/stepMeta';
import { OS_LABEL } from './schema';
import { formatDate, formatDateTime } from './dates';
import type { CycleOverview, SessionOverview, TimelineItem } from './overview';

const OUTCOME: Record<CycleOverview['outcome'], string> = { open: 'Open', completed: 'Marked complete', continued: 'Continued to the next cycle' };
const linkClass = 'text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

function Item({ item }: { item: TimelineItem }) {
  const Icon = item.kind === 'report' ? FileText : item.kind === 'remediation' ? Wrench : Paperclip;
  return (
    <li className="flex gap-2">
      <Icon aria-hidden className="mt-1 size-4 shrink-0 text-muted" />
      <div className="min-w-0">
        <p className="break-words text-text">
          {item.kind === 'report' ? 'LEADS report · ' : item.kind === 'remediation' ? 'Remediation · ' : `Evidence (${STEP_LABEL[item.step]}) · `}
          {item.kind === 'evidence' ? (
            item.label
          ) : (
            <Link href={item.href} className={linkClass}>
              {item.label}
            </Link>
          )}
        </p>
        <p className="text-small text-muted">
          {formatDateTime(item.at)}
          {item.detail ? ` · ${item.detail}` : ''}
        </p>
        {item.kind === 'evidence' && item.filename ? (
          <a href={`/api/files/evidence/${item.evidenceId}`} download className={cn('inline-flex items-center gap-2 text-small', linkClass)}>
            <Download aria-hidden className="size-4 shrink-0" />
            <span className="break-all">Download {item.filename}</span>
          </a>
        ) : null}
      </div>
    </li>
  );
}

function Cycle({ c }: { c: CycleOverview }) {
  return (
    <section aria-label={`Cycle ${c.cycleNo}`} className="flex flex-col gap-2">
      <h3 className="text-body font-semibold text-text">Cycle {c.cycleNo}</h3>
      <p className="text-small text-muted">
        {OUTCOME[c.outcome]} · Reported points:{' '}
        <span className="text-text">{c.points === null ? 'not recorded' : `${c.points}${c.targetPoints !== null ? ` of ${c.targetPoints}` : ''}`}</span>
      </p>
      {c.timeline.length === 0 ? (
        <p className="text-small text-muted">No reports, remediation or evidence in this cycle.</p>
      ) : (
        <ol className="flex flex-col gap-2" aria-label={`Cycle ${c.cycleNo} timeline`}>
          {c.timeline.map((t, i) => (
            <Item key={`${t.kind}-${i}`} item={t} />
          ))}
        </ol>
      )}
    </section>
  );
}

/** Expandable list of sessions (native disclosure: no client JavaScript). */
export function SessionsReport({ sessions }: { sessions: SessionOverview[] }) {
  return (
    <ul className="flex flex-col gap-2" aria-label="Sessions">
      {sessions.map((s) => (
        <li key={s.id} className="rounded-md border border-border bg-surface">
          <details className="group">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted transition-transform duration-150 group-open:rotate-90" />
              <span className="min-w-0 flex-1 truncate text-body font-semibold text-text">{s.title}</span>
              <span className="text-small text-muted">
                {s.status === 'completed' ? 'Completed' : 'Active'} · {OS_LABEL[s.os]} · Cycle {s.currentCycle}
                {s.completedAt ? ` · Completed ${formatDate(s.completedAt)}` : ` · Started ${formatDate(s.createdAt)}`}
              </span>
            </summary>
            <div className="flex flex-col gap-4 border-t border-border p-4">
              {s.cycles.map((c) => (
                <Cycle key={c.cycleNo} c={c} />
              ))}
              <div>
                <Link href={s.href} className={cn(buttonVariants({ variant: 'secondary' }))}>
                  Open session
                  <ArrowRight aria-hidden className="size-4" />
                  <span className="sr-only">{s.title}</span>
                </Link>
              </div>
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}
