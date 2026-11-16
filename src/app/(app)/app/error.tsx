'use client';

import { RouteError } from '@/components/shell/states/RouteError';

/** Error boundary inside the app shell: the sidebar stays, only the page is replaced. */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError digest={error.digest} reset={reset} />;
}
