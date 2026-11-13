import type { Metadata } from 'next';
import { SignOutButton } from '@/features/auth/SignOutButton';
import { requireUser } from '@/server/auth';

export const metadata: Metadata = { title: 'Armadillo' };

// Placeholder until Task 6 replaces it with the dashboard.
export default async function AppPage() {
  const user = await requireUser();
  return (
    <main className="flex min-h-screen flex-col gap-4 bg-bg p-6">
      <h1 className="text-h1 font-semibold text-text">Armadillo</h1>
      <p className="text-body text-muted">
        Signed in as <span className="text-text">{user.email}</span>
      </p>
      <div>
        <SignOutButton />
      </div>
    </main>
  );
}
