'use client';

import { useMemo, type ReactNode } from 'react';
import { PanelRight } from 'lucide-react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Inspector } from '@/components/shell/Inspector';
import { useInspectorStore } from '@/components/shell/inspectorStore';
import { Sidebar, type LibraryCounts, type SidebarSession } from '@/components/shell/Sidebar';

type Props = {
  userEmail: string;
  sessions?: SidebarSession[];
  libraryCounts?: LibraryCounts;
  children: ReactNode;
};

export function AppShell({ userEmail, sessions, libraryCounts, children }: Props) {
  const open = useInspectorStore((s) => s.open);
  const pageSections = useInspectorStore((s) => s.sections);
  const tabSections = useInspectorStore((s) => s.tabSections);
  const sections = useMemo(() => [...tabSections, ...pageSections], [tabSections, pageSections]);
  const toggle = useInspectorStore((s) => s.toggle);
  return (
    <div className="flex h-screen bg-bg text-text">
      <Sidebar userEmail={userEmail} sessions={sessions} libraryCounts={libraryCounts} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-end border-b border-border px-2">
          <button
            type="button"
            aria-label={open ? 'Hide inspector' : 'Show inspector'}
            aria-pressed={open}
            onClick={toggle}
            className="flex size-8 items-center justify-center rounded-sm text-muted transition-colors duration-150 hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent aria-pressed:bg-surface-raised aria-pressed:text-text"
          >
            <PanelRight aria-hidden className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel id="main" minSize="40%">
              <main id="main-content" className="h-full overflow-auto">
                {children}
              </main>
            </ResizablePanel>
            {open ? (
              <>
                <ResizableHandle aria-label="Resize inspector" />
                <ResizablePanel id="inspector" defaultSize="28%" minSize="20%" maxSize="50%">
                  <Inspector sections={sections} onToggle={toggle} />
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>
        </div>
      </div>
    </div>
  );
}
