import type { Metadata } from 'next';
import { FolderPlus } from 'lucide-react';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { NewSessionButton } from '@/features/sessions/NewSessionButton';
import { SessionList } from '@/features/sessions/SessionList';
import { listRecentSessions } from '@/features/sessions/queries';

export const metadata: Metadata = { title: 'Dashboard · Armadillo' };

export default async function AppPage() {
  const sessions = await listRecentSessions(10);
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-h1 font-semibold text-text">Dashboard</h1>
        {sessions.length > 0 ? <NewSessionButton /> : null}
      </div>
      {sessions.length === 0 ? (
        <EmptyState
          icon={FolderPlus}
          title="No hardening sessions yet"
          description="Start a session to work through a hardening round step by step."
          actions={<NewSessionButton />}
        />
      ) : (
        <section aria-labelledby="recent-sessions" className="flex flex-col gap-2">
          <h2 id="recent-sessions" className="text-body font-semibold text-text">
            Recent sessions
          </h2>
          <SessionList sessions={sessions} />
        </section>
      )}
    </div>
  );
}
