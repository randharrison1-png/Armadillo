import type { ReactNode } from 'react';
import Link from 'next/link';
import { getCurrentUser } from '@/server/auth';

/** Public pages: no app shell, just a minimal header. */
export default async function PublicLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  const link = 'rounded-sm px-2 py-1 text-small text-text transition-colors duration-150 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
  return (
    <div className="min-h-screen bg-bg text-text">
      <header className="border-b border-border">
        <div className="mx-auto flex h-12 max-w-4xl items-center justify-between px-4">
          <nav aria-label="Public" className="flex items-center gap-4">
            <span className="text-body font-semibold">Armadillo</span>
            <Link href="/p" className={link}>
              Pastebin
            </Link>
          </nav>
          {user ? (
            <div className="flex items-center gap-2">
              <Link href="/app/pastes" className={link}>
                My pastes
              </Link>
              <Link href="/app" className={link}>
                Workspace
              </Link>
            </div>
          ) : (
            <Link href="/login" className={link}>
              Sign in
            </Link>
          )}
        </div>
      </header>
      <main id="main-content" className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-4">
        {children}
      </main>
    </div>
  );
}
