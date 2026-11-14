import type { Metadata } from 'next';
import { FileClock } from 'lucide-react';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { requireUser } from '@/server/auth';
import { getSessionsOverviewFor } from '@/features/sessions/overview';
import { SessionsReport } from '@/features/sessions/SessionsReport';
import { CreateSessionDialog } from '@/features/sessions/CreateSessionDialog';

export const metadata: Metadata = { title: 'Sessions & Reports · Armadillo' };

export default async function ReportsPage() {
  const user = await requireUser();
  const sessions = await getSessionsOverviewFor(user.id);
  return (
    <div className="flex flex-col gap-6 p-6">
      <h1 className="text-h1 font-semibold text-text">Sessions &amp; Reports</h1>
      {sessions.length === 0 ? (
        <EmptyState
          icon={FileClock}
          title="No sessions yet"
          description="Reports, remediation and evidence of each hardening session appear here."
          actions={<CreateSessionDialog />}
        />
      ) : (
        <SessionsReport sessions={sessions} />
      )}
    </div>
  );
}
