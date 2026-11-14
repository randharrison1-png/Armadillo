'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot, Clipboard, Copy, Download, ExternalLink, Loader2, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getContextStore } from '@/features/claude/contextSelection';
import { OS_LABEL } from '@/features/sessions/schema';
import { duplicateScriptAction, getScriptContent } from './actions';
import { CATEGORY_LABEL, FUNCTION_LABEL } from './filters';
import { downloadHref } from './scriptTabs';
import type { ScriptListItem } from './service';
import type { SessionChoice } from './versionTypes';

export type { SessionChoice } from './versionTypes';

const formatDate = (d: Date) => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(d);

const iconButton =
  'flex size-8 items-center justify-center rounded-sm text-muted transition-colors duration-150 hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60 aria-busy:cursor-progress data-[state=open]:bg-surface-raised data-[state=open]:text-text';

function Tip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ActionButton({
  label,
  icon: Icon,
  busy,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Tip label={label}>
      <button type="button" aria-label={label} aria-busy={busy || undefined} disabled={busy} onClick={onClick} className={iconButton}>
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Icon aria-hidden className="size-4" />}
      </button>
    </Tip>
  );
}

/** "Use in Claude": pick a session; the script's current version joins that session's Claude context. */
function UseInClaude({ script, sessions }: { script: ScriptListItem; sessions: SessionChoice[] }) {
  const router = useRouter();
  if (sessions.length === 0 || !script.current_version_id) {
    const reason = script.current_version_id ? 'Create a session first' : 'This script has no version yet';
    return (
      <Tip label={reason}>
        {/* Wrapper keeps the tooltip reachable: disabled buttons do not fire pointer/focus events. */}
        <span tabIndex={0} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <button type="button" disabled aria-label="Use in Claude" tabIndex={-1} className={iconButton}>
            <Bot aria-hidden className="size-4" />
          </button>
        </span>
      </Tip>
    );
  }
  const versionId = script.current_version_id;
  return (
    <DropdownMenu>
      <Tip label="Use in Claude">
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Use in Claude" className={iconButton}>
            <Bot aria-hidden className="size-4" />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Add to a session&apos;s Claude context</DropdownMenuLabel>
        {sessions.map((s) => (
          <DropdownMenuItem
            key={s.id}
            onSelect={() => {
              getContextStore(s.id).getState().add({ type: 'script_version', id: versionId });
              toast.success(`Added ${script.name} to Claude context`);
              router.push(`/app/sessions/${s.id}`);
            }}
          >
            <span className="truncate">{s.title}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RowActions({ script, sessions }: { script: ScriptListItem; sessions: SessionChoice[] }) {
  const [copying, setCopying] = useState(false);
  const [clipping, setClipping] = useState(false);

  const copy = async () => {
    setCopying(true);
    try {
      const r = await duplicateScriptAction(script.id);
      if (r.ok) toast.success(`Copied as ${r.name}`);
      else toast.error(r.errors.form ?? 'Could not copy the script. Try again.');
    } catch {
      toast.error('Could not copy the script. Try again.');
    } finally {
      setCopying(false);
    }
  };

  const toClipboard = async () => {
    setClipping(true);
    try {
      const r = await getScriptContent(script.id);
      if (!r.ok) throw new Error(r.error);
      await navigator.clipboard.writeText(r.content);
      toast.success(`Copied ${script.filename} to the clipboard`);
    } catch {
      toast.error('Could not copy to the clipboard. Try again.');
    } finally {
      setClipping(false);
    }
  };

  return (
    <div className="flex items-center justify-end gap-1">
      <Tip label="Open">
        <Link href={`/app/library/${script.id}`} aria-label="Open" className={iconButton}>
          <ExternalLink aria-hidden className="size-4" />
        </Link>
      </Tip>
      {script.current_version_id ? (
        <Tip label={`Download v${script.current_version_no ?? ''}`.trim()}>
          <a href={downloadHref(script.current_version_id)} download aria-label="Download" className={iconButton}>
            <Download aria-hidden className="size-4" />
          </a>
        </Tip>
      ) : null}
      <ActionButton label="Copy" icon={Copy} busy={copying} onClick={copy} />
      <ActionButton label="Copy to clipboard" icon={Clipboard} busy={clipping} onClick={toClipboard} />
      <UseInClaude script={script} sessions={sessions} />
    </div>
  );
}

const th = 'px-2 py-2 text-left text-small font-medium text-muted';
const td = 'px-2 py-2 align-middle text-small';

export function ScriptTable({ scripts, sessions }: { scripts: ScriptListItem[]; sessions: SessionChoice[] }) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="overflow-x-auto rounded-md border border-border bg-surface">
        <table className="w-full min-w-[56rem] border-collapse">
          <caption className="sr-only">Scripts</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={th}>Name</th>
              <th scope="col" className={th}>Filename</th>
              <th scope="col" className={th}>Category</th>
              <th scope="col" className={th}>Function</th>
              <th scope="col" className={th}>Systems</th>
              <th scope="col" className={th}>Version</th>
              <th scope="col" className={th}>Updated</th>
              <th scope="col" className={cn(th, 'text-right')}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {scripts.map((s) => (
              <tr key={s.id} className="border-b border-border last:border-b-0 hover:bg-surface-raised">
                <th scope="row" className={cn(td, 'max-w-72 text-left font-medium')}>
                  <Link
                    href={`/app/library/${s.id}`}
                    className="block truncate rounded-sm text-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    title={s.description ?? undefined}
                  >
                    {s.name}
                  </Link>
                  {s.session_id ? <span className="block text-small font-normal text-muted">Session script</span> : null}
                </th>
                <td className={cn(td, 'font-mono text-text')}>{s.filename}</td>
                <td className={td}>{CATEGORY_LABEL[s.category]}</td>
                <td className={td}>{FUNCTION_LABEL[s.function]}</td>
                <td className={cn(td, 'text-muted')}>{s.os_compat.map((o) => OS_LABEL[o]).join(', ')}</td>
                <td className={cn(td, 'font-mono')}>{s.current_version_no ? `v${s.current_version_no}` : '—'}</td>
                <td className={cn(td, 'whitespace-nowrap text-muted')}>{formatDate(s.updated_at)}</td>
                <td className={td}>
                  <RowActions script={s} sessions={sessions} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TooltipProvider>
  );
}
