'use client';

import * as React from 'react';
import { Circle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { TabDescriptor } from '@/lib/types';
import { draftKey, isDirty, useDrafts } from '@/features/workspace/drafts';
import { SESSION_WORKSPACE, useWorkspace, type WorkspaceConfig } from '@/features/workspace/store';
import { TAB_ICONS, TabBody } from '@/components/shell/TabBody';

type Props = { sessionId: string } | { namespace: string; config: WorkspaceConfig };

/** Keys of `namespace`'s tabs with unsaved drafts, as one string so the selector result is stable. */
const dirtyKeys = (namespace: string) => (s: ReturnType<typeof useDrafts.getState>) => {
  const prefix = draftKey(namespace, '');
  return Object.entries(s.drafts)
    .filter(([k, d]) => k.startsWith(prefix) && isDirty(d))
    .map(([k]) => k.slice(prefix.length))
    .sort()
    .join('\u0000');
};

/**
 * Editor-style tab strip and body for one workspace: a session (namespace = session id) or a
 * library script page (namespace `library:<scriptId>`, see libraryWorkspace). Tabs with unsaved
 * edits show a marker; closing one asks first, and leaving the page warns while any are dirty.
 */
export function WorkspaceTabs(props: Props) {
  const namespace = 'sessionId' in props ? props.sessionId : props.namespace;
  const config = 'sessionId' in props ? SESSION_WORKSPACE : props.config;
  const { tabs, activeKey, activate, closeTab } = useWorkspace(namespace, config);
  const refs = React.useRef(new Map<string, HTMLButtonElement>());
  const active = tabs.find((t) => t.key === activeKey) ?? null;
  const dirtyList = useDrafts(dirtyKeys(namespace));
  const dirty = React.useMemo(() => new Set(dirtyList ? dirtyList.split('\u0000') : []), [dirtyList]);
  const clearDraft = useDrafts((s) => s.clear);
  const [closing, setClosing] = React.useState<TabDescriptor | null>(null);

  const requestClose = (tab: TabDescriptor) => {
    if (dirty.has(tab.key)) return setClosing(tab);
    clearDraft(draftKey(namespace, tab.key));
    closeTab(tab.key);
  };

  React.useEffect(() => {
    if (dirty.size === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else if (e.key === 'Delete' && tabs[index].key !== config.pinned) {
      e.preventDefault();
      requestClose(tabs[index]);
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
                {dirty.has(t.key) ? (
                  <>
                    <Circle aria-hidden className="size-2 shrink-0 fill-current text-warning" />
                    <span className="sr-only">Unsaved changes</span>
                  </>
                ) : null}
              </button>
              {t.key === config.pinned ? null : (
                <button
                  type="button"
                  aria-label={`Close ${t.title}`}
                  onClick={() => requestClose(t)}
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
        {active ? <TabBody tab={active} namespace={namespace} /> : null}
      </div>
      <Dialog open={!!closing} onOpenChange={(o) => !o && setClosing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              {closing?.title} has edits that are not saved as a version. Closing the tab discards them; saved versions are not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setClosing(null)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (closing) {
                  clearDraft(draftKey(namespace, closing.key));
                  closeTab(closing.key);
                }
                setClosing(null);
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
