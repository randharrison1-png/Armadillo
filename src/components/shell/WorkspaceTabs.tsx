'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PINNED_TAB_KEY, useWorkspace } from '@/features/workspace/store';
import { TAB_ICONS, TabBody } from '@/components/shell/TabBody';

/** Editor-style tab strip and body for one session. */
export function WorkspaceTabs({ sessionId }: { sessionId: string }) {
  const { tabs, activeKey, activate, closeTab } = useWorkspace(sessionId);
  const refs = React.useRef(new Map<string, HTMLButtonElement>());
  const active = tabs.find((t) => t.key === activeKey) ?? null;

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else if (e.key === 'Delete' && tabs[index].key !== PINNED_TAB_KEY) {
      e.preventDefault();
      closeTab(tabs[index].key);
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    const key = tabs[next].key;
    activate(key);
    refs.current.get(key)?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Workspace tabs" className="flex h-10 shrink-0 items-end overflow-x-auto border-b border-border bg-surface">
        {tabs.map((t, i) => {
          const Icon = TAB_ICONS[t.kind];
          const isActive = t.key === activeKey;
          return (
            <div
              key={t.key}
              className={cn(
                'flex h-full shrink-0 items-center border-r border-border transition-colors duration-150',
                isActive ? 'bg-bg text-text' : 'text-muted hover:bg-surface-raised hover:text-text',
              )}
            >
              <button
                type="button"
                role="tab"
                id={`tab-${t.key}`}
                aria-selected={isActive}
                aria-controls="workspace-panel"
                tabIndex={isActive ? 0 : -1}
                ref={(el) => {
                  if (el) refs.current.set(t.key, el);
                  else refs.current.delete(t.key);
                }}
                onClick={() => activate(t.key)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className="flex h-full max-w-48 items-center gap-2 px-4 text-small focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
              >
                <Icon aria-hidden className={cn('size-4 shrink-0', isActive && 'text-accent')} />
                <span className="truncate">{t.title}</span>
              </button>
              {t.key === PINNED_TAB_KEY ? null : (
                <button
                  type="button"
                  aria-label={`Close ${t.title}`}
                  onClick={() => closeTab(t.key)}
                  className="mr-2 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted transition-colors duration-150 hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <X aria-hidden className="size-4" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id="workspace-panel"
        aria-labelledby={active ? `tab-${active.key}` : undefined}
        className="min-h-0 flex-1 overflow-auto bg-bg"
      >
        {active ? <TabBody tab={active} /> : null}
      </div>
    </div>
  );
}
