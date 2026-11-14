'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { FileQuestion, Info } from 'lucide-react';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { ErrorState } from '@/components/shell/states/ErrorState';
import { LoadingState } from '@/components/shell/states/LoadingState';
import type { Script, ScriptVersion, TabDescriptor } from '@/lib/types';
import { lineDiffStats } from './lineDiff';
import { formatLabel } from './scriptMeta';
import { parseDiffResourceId } from './scriptTabs';
import { loadVersion } from './versionActions';

const CodeDiff = dynamic(() => import('./monaco/CodeEditor').then((m) => m.CodeDiff), {
  ssr: false,
  loading: () => <LoadingState label="Loading comparison" />,
});

type Loaded = { script: Script; from: ScriptVersion; to: ScriptVersion };

const when = (d: Date) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d));

/** Body of a 'diff' workspace tab (resourceId `<scriptId>:<fromVersionId>..<toVersionId>`): two versions side by side, read-only. */
export function VersionDiffTab({ tab }: { tab: TabDescriptor }) {
  const resourceId = tab.resourceId;
  const ids = useMemo(() => (resourceId ? parseDiffResourceId(resourceId) : null), [resourceId]);
  const [state, setState] = useState<Loaded | 'missing' | 'failed' | null>(null);

  useEffect(() => {
    if (!ids || state !== null) return;
    let live = true;
    Promise.all([loadVersion(ids.fromVersionId), loadVersion(ids.toVersionId)])
      .then(([a, b]) => {
        if (!live) return;
        const ok = a && b && a.version.script_id === ids.scriptId && b.version.script_id === ids.scriptId;
        setState(ok ? { script: b.script, from: a.version, to: b.version } : 'missing');
      })
      .catch(() => live && setState('failed'));
    return () => {
      live = false;
    };
  }, [ids, state]);

  const stats = useMemo(() => (state && typeof state === 'object' ? lineDiffStats(state.from.content, state.to.content) : null), [state]);

  if (!ids || state === 'missing') {
    return <EmptyState icon={FileQuestion} title="Nothing to compare" description="One of these versions no longer exists, or it belongs to another account." />;
  }
  if (state === 'failed') return <ErrorState title="Could not load the versions" onRetry={() => setState(null)} />;
  if (!state || !stats) return <LoadingState label="Loading versions" />;

  const { script, from, to } = state;
  const label = `v${from.version_no} and v${to.version_no}`;
  const formatDiffers = from.encoding !== to.encoding || from.line_ending !== to.line_ending;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-4 py-2">
        <h2 className="text-body font-semibold text-text">
          {script.name}: v{from.version_no} ↔ v{to.version_no}
        </h2>
        <p className="flex flex-wrap gap-x-2 text-small text-muted">
          <span className="font-mono text-text">{script.filename}</span>
          <span aria-hidden>·</span>
          <span>
            Left v{from.version_no}, {when(from.created_at)}
          </span>
          <span aria-hidden>·</span>
          <span>
            Right v{to.version_no}, {when(to.created_at)}
          </span>
          <span aria-hidden>·</span>
          <span className="font-mono text-text">
            {stats.approximate ? '≤' : ''}+{stats.added} −{stats.removed} lines
          </span>
        </p>
        {formatDiffers ? (
          <p role="note" className="flex items-center gap-2 text-small text-muted">
            <Info aria-hidden className="size-4 shrink-0" />
            The files differ on disk too: v{from.version_no} is {formatLabel(from)}, v{to.version_no} is {formatLabel(to)}.
          </p>
        ) : null}
      </div>
      <section aria-label={`Comparison of ${label}`} className="min-h-0 flex-1">
        <CodeDiff original={from.content} modified={to.content} language={to.language} ariaLabel={`${script.filename} ${label}`} />
      </section>
    </div>
  );
}
