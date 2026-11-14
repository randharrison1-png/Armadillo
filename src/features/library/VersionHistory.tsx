'use client';

import { useState } from 'react';
import { Download, Eye, GitCompare, History, Loader2, RotateCcw, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { downloadHref } from './scriptTabs';
import { formatLabel } from './scriptMeta';
import type { VersionSummary } from './versionTypes';

const iconButton =
  'flex size-6 items-center justify-center rounded-sm text-muted transition-colors duration-150 hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60';

const when = (d: Date) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d));

function IconAction({ label, icon: Icon, onClick, busy, disabled }: { label: string; icon: LucideIcon; onClick: () => void; busy?: boolean; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} onClick={onClick} disabled={disabled || busy} aria-busy={busy || undefined} className={iconButton}>
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Icon aria-hidden className="size-4" />}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

type Props = {
  versions: VersionSummary[];
  currentId: string;
  /** Read-only: hides Restore (e.g. a completed session). */
  readOnly?: boolean;
  restoringId?: string | null;
  onView: (v: VersionSummary) => void;
  /** `from` is the older version. */
  onCompare: (from: VersionSummary, to: VersionSummary) => void;
  onRestore: (v: VersionSummary) => void;
};

/**
 * Every version of a script, newest first: number, author, change note, time, sha256 prefix and
 * on-disk format. View / compare / download / restore per version; tick two to compare them.
 */
export function VersionHistory({ versions, currentId, readOnly, restoringId, onView, onCompare, onRestore }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const current = versions.find((v) => v.id === currentId);
  const picked = versions.filter((v) => selected.includes(v.id)).sort((a, b) => a.version_no - b.version_no);

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => (on ? [...s.filter((x) => x !== id), id].slice(-2) : s.filter((x) => x !== id)));

  return (
    <TooltipProvider delayDuration={200}>
      <section aria-label="Version history" className="flex h-full w-72 shrink-0 flex-col border-l border-border bg-surface">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
          <History aria-hidden className="size-4 text-muted" />
          <h3 className="text-small font-semibold text-text">Version history</h3>
        </div>
        {versions.length === 0 ? (
          <EmptyState icon={History} title="No versions yet" />
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
              {picked.length === 2 ? (
                <Button variant="secondary" className="w-full" onClick={() => onCompare(picked[0]!, picked[1]!)}>
                  <GitCompare aria-hidden className="size-4" />
                  Compare v{picked[0]!.version_no} and v{picked[1]!.version_no}
                </Button>
              ) : (
                <p className="text-small text-muted">Tick two versions to compare them.</p>
              )}
            </div>
            <ol className="min-h-0 flex-1 overflow-y-auto">
              {versions.map((v) => {
                const isCurrent = v.id === currentId;
                const checkboxId = `compare-${v.id}`;
                return (
                  <li key={v.id} className={cn('flex flex-col gap-1 border-b border-border px-4 py-2', isCurrent && 'bg-surface-raised')}>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={checkboxId}
                        aria-label={`Select v${v.version_no} for comparison`}
                        checked={selected.includes(v.id)}
                        onCheckedChange={(on) => toggle(v.id, on === true)}
                      />
                      <label htmlFor={checkboxId} className="font-mono text-small font-medium text-text">
                        v{v.version_no}
                      </label>
                      {isCurrent ? <span className="text-small text-accent">Current</span> : null}
                      <span className="ml-auto flex items-center gap-1">
                        <IconAction label={`View v${v.version_no}`} icon={Eye} onClick={() => onView(v)} />
                        {!isCurrent && current ? (
                          <IconAction label={`Compare v${v.version_no} with current`} icon={GitCompare} onClick={() => onCompare(v, current)} />
                        ) : null}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <a href={downloadHref(v.id)} download aria-label={`Download v${v.version_no}`} className={iconButton}>
                              <Download aria-hidden className="size-4" />
                            </a>
                          </TooltipTrigger>
                          <TooltipContent>{`Download v${v.version_no}`}</TooltipContent>
                        </Tooltip>
                        {!isCurrent && !readOnly ? (
                          <IconAction
                            label={`Restore v${v.version_no}`}
                            icon={RotateCcw}
                            busy={restoringId === v.id}
                            disabled={!!restoringId}
                            onClick={() => onRestore(v)}
                          />
                        ) : null}
                      </span>
                    </div>
                    {v.change_note ? <p className="break-words text-small text-text">{v.change_note}</p> : null}
                    <p className="text-small text-muted">
                      {v.author === 'claude' ? 'Claude' : 'You'} · {when(v.created_at)}
                    </p>
                    <p className="text-small text-muted">
                      <span className="font-mono" title={`SHA-256 ${v.sha256}`}>
                        {v.sha256.slice(0, 12)}
                      </span>{' '}
                      · {formatLabel(v)}
                    </p>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </section>
    </TooltipProvider>
  );
}
