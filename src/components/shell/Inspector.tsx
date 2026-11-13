'use client';

import type { ReactNode } from 'react';
import { Info, PanelRightClose } from 'lucide-react';
import { EmptyState } from '@/components/shell/states/EmptyState';

export type InspectorSection = { id: string; title: string; content: ReactNode };

type Props = { sections: InspectorSection[]; onToggle: () => void };

/** Right panel body. Visibility and width are owned by AppShell; `onToggle` closes it. */
export function Inspector({ sections, onToggle }: Props) {
  return (
    <aside aria-label="Inspector" className="flex h-full min-w-0 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-small font-semibold text-text">Inspector</h2>
        <button
          type="button"
          aria-label="Close inspector"
          onClick={onToggle}
          className="flex size-6 items-center justify-center rounded-sm text-muted transition-colors duration-150 hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <PanelRightClose aria-hidden className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sections.length === 0 ? (
          <EmptyState icon={Info} title="Nothing selected" description="Details for the current view appear here." />
        ) : (
          sections.map((s) => (
            <section key={s.id} aria-labelledby={`inspector-${s.id}`} className="border-b border-border p-4">
              <h3 id={`inspector-${s.id}`} className="mb-2 text-small font-semibold text-text">
                {s.title}
              </h3>
              <div className="text-small text-muted">{s.content}</div>
            </section>
          ))
        )}
      </div>
    </aside>
  );
}
