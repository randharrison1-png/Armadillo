import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

type Props = { icon: LucideIcon; title: string; description?: string; actions?: ReactNode };

export function EmptyState({ icon: Icon, title, description, actions }: Props) {
  return (
    <div className="flex flex-col items-center gap-2 p-6 text-center">
      <Icon aria-hidden className="size-6 text-muted" />
      <h2 className="text-body font-semibold text-text">{title}</h2>
      {description ? <p className="max-w-md text-small text-muted">{description}</p> : null}
      {actions ? <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}
