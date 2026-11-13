import Link from 'next/link';
import { BookOpen, SearchX } from 'lucide-react';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { listRecentSessions } from '@/features/sessions/queries';
import { hasActiveFilters, type LibraryQuery } from './filters';
import { LibraryFilters } from './LibraryFilters';
import { searchScripts } from './queries';
import { CreateScriptDialog, UploadScriptDialog } from './ScriptDialogs';
import { ScriptTable } from './ScriptTable';

/** The script library: empty-first, with search and filters held in the URL. */
export async function LibraryPage({ query }: { query: LibraryQuery }) {
  const [scripts, sessions] = await Promise.all([searchScripts(query), listRecentSessions(10)]);
  const filtered = hasActiveFilters(query);
  const libraryEmpty = scripts.length === 0 && !filtered;
  // Completed sessions are read-only, so they are not offered as Claude-context targets.
  const targets = sessions.filter((s) => s.status === 'active').map((s) => ({ id: s.id, title: s.title }));

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-h1 font-semibold text-text">Script Library</h1>
        {libraryEmpty ? null : (
          <div className="flex gap-2">
            <UploadScriptDialog />
            <CreateScriptDialog />
          </div>
        )}
      </div>
      {libraryEmpty ? (
        <EmptyState
          icon={BookOpen}
          title="No scripts in your library"
          description="Upload a script file or write one here. Scripts you add are kept as versioned, reusable library entries."
          actions={
            <>
              <UploadScriptDialog />
              <CreateScriptDialog />
            </>
          }
        />
      ) : (
        <>
          <LibraryFilters />
          {scripts.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title="No scripts match"
              description="Try a different search, or clear the filters."
              actions={
                <Link href="/app/library" className={cn(buttonVariants({ variant: 'secondary' }))}>
                  Clear filters
                </Link>
              }
            />
          ) : (
            <ScriptTable scripts={scripts} sessions={targets} />
          )}
        </>
      )}
    </div>
  );
}
