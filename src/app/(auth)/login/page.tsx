import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { safeNext } from '@/lib/safeNext';
import { LoginForm } from '@/features/auth/LoginForm';
import { authMode, getCurrentUser } from '@/server/auth';

export const metadata: Metadata = { title: 'Sign in · Armadillo' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const dest = safeNext(next);
  if (await getCurrentUser()) redirect(dest);
  const mode = authMode();

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-md border border-border bg-surface p-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-h1 font-semibold text-text">Sign in to Armadillo</h1>
          <p className="text-small text-muted">
            {mode === 'test' ? 'Test sign-in: enter any email address.' : 'Use your email and password.'}
          </p>
        </div>
        {error === 'confirm' ? (
          <p role="alert" className="text-small text-danger">
            That confirmation link is invalid or has expired. Sign in or create the account again.
          </p>
        ) : null}
        <LoginForm mode={mode} next={dest === '/app' ? undefined : dest} />
      </div>
    </main>
  );
}
