import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Props = { title: string; detail?: string; onRetry?: () => void };

export function ErrorState({ title, detail, onRetry }: Props) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 p-6 text-center">
      <AlertTriangle aria-hidden className="size-6 text-danger" />
      <h2 className="text-body font-semibold text-text">{title}</h2>
      {detail ? <p className="max-w-md text-small text-muted">{detail}</p> : null}
      {onRetry ? (
        <Button variant="secondary" className="mt-2" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
