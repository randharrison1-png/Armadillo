import type { Metadata } from 'next';
import { FolderPlus } from 'lucide-react';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { NewSessionButton } from '@/features/sessions/NewSessionButton';
import { SessionList } from '@/features/sessions/SessionList';
import { listAllSessions } from '@/features/sessions/queries';

export const metadata: Metadata = { title: 'Sessions · Armadillo' };

export default async function SessionsPage() {
  const sessions = await listAllSessions();
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-h1 font-semibold text-text">Sessions</h1>
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
        <SessionList sessions={sessions} />
      )}
    </div>
  );
}
