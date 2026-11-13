'use client';

import { Bot, FileText, GitBranch, GitCompare, ListChecks, ScrollText, Terminal, type LucideIcon } from 'lucide-react';
import { EmptyState } from '@/components/shell/states/EmptyState';
import type { TabDescriptor, TabKind } from '@/lib/types';

export const TAB_ICONS: Record<TabKind, LucideIcon> = {
  claude: Bot,
  readme: FileText,
  script: Terminal,
  diff: GitCompare,
  flowchart: GitBranch,
  report: ScrollText,
  requirements: ListChecks,
};

/**
 * Body per tab kind. Each owning task replaces its case with the real view;
 * until then a neutral placeholder keeps the shell usable.
 */
export function TabBody({ tab }: { tab: TabDescriptor }) {
  switch (tab.kind) {
    case 'claude':
    case 'readme':
    case 'script':
    case 'diff':
    case 'flowchart':
    case 'report':
    case 'requirements':
      return <EmptyState icon={TAB_ICONS[tab.kind]} title={tab.title} description="Nothing here yet." />;
  }
}
