'use client';

import { RouteError } from '@/components/shell/states/RouteError';

/** Error boundary for everything outside the app shell (public pages, sign-in). */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError digest={error.digest} reset={reset} fullPage />;
}
