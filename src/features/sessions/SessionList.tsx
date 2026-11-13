import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { stageLabel } from '@/features/flowchart/stepMeta';
import { OS_LABEL } from './schema';
import type { SessionSummary } from './service';

const formatDate = (d: Date) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(d);

/** Compact rows: title, system, workflow stage, last update, and a Resume link. */
export function SessionList({ sessions }: { sessions: Pick<SessionSummary, 'id' | 'title' | 'os' | 'status' | 'updated_at' | 'currentStep'>[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {sessions.map((s) => (
        <li key={s.id} className="flex items-center gap-4 rounded-md border border-border bg-surface p-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-body font-semibold text-text">{s.title}</span>
            <span className="truncate text-small text-muted">
              {OS_LABEL[s.os]} · {stageLabel(s.status, s.currentStep)} · Updated {formatDate(s.updated_at)} UTC
            </span>
          </div>
          <Link href={`/app/sessions/${s.id}`} className={cn(buttonVariants({ variant: 'secondary' }))}>
            Resume
            <ArrowRight aria-hidden className="size-4" />
            <span className="sr-only">{s.title}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
