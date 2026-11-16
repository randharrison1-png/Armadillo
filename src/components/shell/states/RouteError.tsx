'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Body of every route error boundary (error.tsx). Deliberately generic: the thrown error's message
 * and stack can contain internals (hostnames, SQL, file paths), so only Next's opaque `digest`
 * is shown, as a reference an administrator can look up in the server log.
 *
 * "Try again" refetches the route from the server before resetting the boundary: for an error
 * thrown while rendering a server component, `reset()` alone would just re-render the same
 * failed payload.
 */
export function RouteError({ digest, reset, fullPage = false }: { digest?: string; reset: () => void; fullPage?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });

  return (
    <div role="alert" className={cn('flex flex-col items-center gap-2 p-6 text-center', fullPage && 'min-h-screen justify-center bg-bg')}>
      <AlertTriangle aria-hidden className="size-6 text-danger" />
      <h1 className="text-h1 font-semibold text-text">Something went wrong</h1>
      <p className="max-w-md text-small text-muted">
        This page could not be loaded. Try again. If it keeps happening, tell the administrator.
      </p>
      {digest ? (
        <p className="text-small text-muted">
          Reference: <span className="font-mono text-text">{digest}</span>
        </p>
      ) : null}
      <Button className="mt-2" loading={pending} onClick={retry}>
        Try again
      </Button>
    </div>
  );
}
