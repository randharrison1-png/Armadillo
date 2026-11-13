import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { listRecentSessions } from '@/features/sessions/queries';
import { requireUser } from '@/server/auth';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const recent = await listRecentSessions(10);
  // Library counts are supplied by Task 8; the shell is prop-driven.
  return (
    <AppShell userEmail={user.email} sessions={recent.map((s) => ({ id: s.id, title: s.title }))}>
      {children}
    </AppShell>
  );
}
