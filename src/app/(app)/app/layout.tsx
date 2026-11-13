import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { listRecentSessions } from '@/features/sessions/queries';
import { getLibraryCounts } from '@/features/library/queries';
import { Toaster } from '@/components/ui/sonner';
import { requireUser } from '@/server/auth';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const [recent, libraryCounts] = await Promise.all([listRecentSessions(10), getLibraryCounts()]);
  return (
    <AppShell userEmail={user.email} sessions={recent.map((s) => ({ id: s.id, title: s.title }))} libraryCounts={libraryCounts}>
      {children}
      <Toaster />
    </AppShell>
  );
}
