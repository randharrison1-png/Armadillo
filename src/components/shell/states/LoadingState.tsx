import { Loader2 } from 'lucide-react';

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-busy="true" className="flex items-center justify-center gap-2 p-6 text-small text-muted">
      <Loader2 aria-hidden className="size-4 animate-spin" />
      <span>{label}</span>
    </div>
  );
}
