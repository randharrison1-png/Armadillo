import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { requireUser } from '@/server/auth';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  // Recent sessions and library counts are supplied by Tasks 6 and 8; the shell is prop-driven.
  return <AppShell userEmail={user.email}>{children}</AppShell>;
}
