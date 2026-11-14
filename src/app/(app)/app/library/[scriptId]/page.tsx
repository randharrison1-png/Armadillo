import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireUser } from '@/server/auth';
import { listRecentSessions } from '@/features/sessions/queries';
import { ScriptWorkspace } from '@/features/library/ScriptWorkspace';
import { getScriptEditorDataFor } from '@/features/library/versioning';

export const metadata: Metadata = { title: 'Script · Armadillo' };

/** A library script outside any session: editor, version history, diffs and downloads in its own tab strip. */
export default async function ScriptPage({ params }: { params: Promise<{ scriptId: string }> }) {
  const { scriptId } = await params;
  const user = await requireUser();
  const [data, sessions] = await Promise.all([getScriptEditorDataFor(user.id, scriptId), listRecentSessions(10)]);
  if (!data) notFound();
  // Completed sessions are read-only, so only active ones are fork targets.
  const forkTargets = sessions.filter((s) => s.status === 'active').map((s) => ({ id: s.id, title: s.title }));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <Link
          href="/app/library"
          className="flex w-fit items-center gap-2 rounded-sm text-small text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Script Library
        </Link>
      </div>
      <div className="min-h-0 flex-1">
        <ScriptWorkspace initial={data} forkTargets={forkTargets} />
      </div>
    </div>
  );
}
