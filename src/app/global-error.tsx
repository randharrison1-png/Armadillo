'use client';

import { GeistSans } from 'geist/font/sans';
import { AlertTriangle } from 'lucide-react';
import './globals.css';

/**
 * Last-resort boundary for errors in the root layout itself. It replaces the whole document, so it
 * renders its own <html>/<body> and reloads the page to retry (there is no router to refresh).
 * Like the route boundaries it never shows the error message, only the digest.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" className={GeistSans.variable}>
      <body>
        <div role="alert" className="flex min-h-screen flex-col items-center justify-center gap-2 bg-bg p-6 text-center">
          <AlertTriangle aria-hidden className="size-6 text-danger" />
          <h1 className="text-h1 font-semibold text-text">Something went wrong</h1>
          <p className="max-w-md text-small text-muted">
            Armadillo could not load. Try again. If it keeps happening, tell the administrator.
          </p>
          {error.digest ? (
            <p className="text-small text-muted">
              Reference: <span className="font-mono text-text">{error.digest}</span>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 inline-flex h-control items-center justify-center rounded-sm bg-accent px-4 text-small font-medium text-accent-ink transition-colors duration-150 hover:bg-accent/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
