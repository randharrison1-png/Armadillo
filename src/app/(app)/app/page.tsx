import type { Metadata } from 'next';
import { requireUser } from '@/server/auth';

export const metadata: Metadata = { title: 'Armadillo' };

// Placeholder until Task 6 replaces it with the dashboard. The shell layout renders the account control.
export default async function AppPage() {
  await requireUser();
  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-h1 font-semibold text-text">Dashboard</h1>
    </div>
  );
}
