'use client';

import dynamic from 'next/dynamic';
import { Bot, FileText, GitBranch, GitCompare, ListChecks, ScrollText, Terminal, type LucideIcon } from 'lucide-react';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { LoadingState } from '@/components/shell/states/LoadingState';
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

// Client-only: the editor and diff views run Monaco, which cannot render on the server.
const ScriptEditorTab = dynamic(() => import('@/features/library/ScriptEditorTab').then((m) => m.ScriptEditorTab), {
  ssr: false,
  loading: () => <LoadingState label="Loading editor" />,
});
const ReadmeTab = dynamic(() => import('@/features/readme/ReadmeTab').then((m) => m.ReadmeTab), {
  ssr: false,
  loading: () => <LoadingState label="Loading README" />,
});
const ClaudeTab = dynamic(() => import('@/features/claude/ClaudeTab').then((m) => m.ClaudeTab), {
  ssr: false,
  loading: () => <LoadingState label="Loading Claude" />,
});
const RequirementsTab = dynamic(() => import('@/features/requirements/RequirementsTab').then((m) => m.RequirementsTab), {
  ssr: false,
  loading: () => <LoadingState label="Loading requirements" />,
});
const VersionDiffTab = dynamic(() => import('@/features/library/VersionDiffTab').then((m) => m.VersionDiffTab), {
  ssr: false,
  loading: () => <LoadingState label="Loading comparison" />,
});
const FlowchartTab = dynamic(() => import('@/features/flowchart/FlowchartTab').then((m) => m.FlowchartTab), {
  ssr: false,
  loading: () => <LoadingState label="Loading flowchart" />,
});
const ReportTab = dynamic(() => import('@/features/reports/ReportTab').then((m) => m.ReportTab), {
  ssr: false,
  loading: () => <LoadingState label="Loading report" />,
});
const ProposalDiffTab = dynamic(() => import('@/features/proposals/ProposalDiffTab').then((m) => m.ProposalDiffTab), {
  ssr: false,
  loading: () => <LoadingState label="Loading proposal" />,
});

/**
 * Body per tab kind. `namespace` is the workspace the tab lives in (a session id, or
 * `library:<scriptId>`): editors key their unsaved drafts by it and open new tabs into it.
 * Each owning task replaces its case with the real view; until then a neutral placeholder keeps
 * the shell usable.
 */
export function TabBody({ tab, namespace }: { tab: TabDescriptor; namespace: string }) {
  switch (tab.kind) {
    case 'script':
      return tab.resourceId ? (
        <ScriptEditorTab namespace={namespace} tab={tab} />
      ) : (
        <EmptyState icon={TAB_ICONS.script} title={tab.title} description="Nothing here yet." />
      );
    case 'diff':
      // resourceId `proposal:<id>`: a Claude proposal under review; otherwise two versions (scriptTabs.ts).
      return tab.resourceId?.startsWith('proposal:') ? (
        <ProposalDiffTab tab={tab} namespace={namespace} />
      ) : tab.resourceId ? (
        <VersionDiffTab tab={tab} />
      ) : (
        <EmptyState icon={TAB_ICONS.diff} title={tab.title} description="Nothing here yet." />
      );
    case 'readme':
      return <ReadmeTab tab={tab} namespace={namespace} />;
    case 'claude':
      return <ClaudeTab tab={tab} namespace={namespace} />;
    case 'requirements':
      return <RequirementsTab tab={tab} namespace={namespace} />;
    case 'flowchart':
      return <FlowchartTab tab={tab} namespace={namespace} />;
    case 'report':
      return <ReportTab tab={tab} namespace={namespace} />;
  }
}
