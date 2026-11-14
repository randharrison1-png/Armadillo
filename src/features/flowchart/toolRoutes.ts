import type { ResourceRef, StepKey, TabDescriptor } from '@/lib/types';
import type { ConversationMode } from '@/features/claude/types';
import { requestClaudeIntent } from '@/features/claude/claudeIntent';
import { scriptTab } from '@/features/library/scriptTabs';
import { readmeTab } from '@/features/readme/readmeUi';
import { proposalTab } from '@/features/proposals/review';
import { REPORTS_TAB, reportTab } from '@/features/reports/reportUi';
import { REQUIREMENTS_TAB } from '@/features/requirements/matrix';
import { getWorkspaceStore } from '@/features/workspace/store';
import type { LatestRemediation } from './types';

export type ToolContext = {
  sessionId: string;
  latestReport: { id: string; filename: string } | null;
  latestSessionScript: { scriptId: string; filename: string } | null;
  latestRemediation: LatestRemediation | null;
};

/** Inspector sections that stand in for tools Task 18 builds (forensic questions, final points, submit). */
export type InspectorTarget = 'forensic' | 'points' | 'submit';

export type ToolRoute = TabDescriptor & {
  /** Button text. */
  label: string;
  /** Resources to select as Claude context (inspect_leads). */
  refs?: ResourceRef[];
  /** Claude tab only: the conversation mode to work in. */
  mode?: ConversationMode;
  /** Navigate here instead of opening a tab (no session script yet: the library). */
  href?: string;
  /** Present when the action cannot run yet; shown as the tooltip. */
  disabledReason?: string;
  /** The tool lives in this section of the node panel. */
  inspectorSection?: InspectorTarget;
};

const FLOWCHART_TAB: TabDescriptor = { key: 'flowchart', kind: 'flowchart', title: 'Flowchart' };
const CLAUDE_TAB: TabDescriptor = { key: 'claude', kind: 'claude', title: 'Claude' };

/** Where a step's action button goes. Pure: tabs are opened by openToolRoute. */
export function toolRouteFor(step: StepKey, ctx: ToolContext): ToolRoute {
  switch (step) {
    case 'open_readme':
      return { ...readmeTab(), label: 'Open README' };
    case 'forensic_questions':
      return { ...FLOWCHART_TAB, label: 'Open forensic questions', inspectorSection: 'forensic' };
    case 'claude_adaptation':
      return { ...REQUIREMENTS_TAB, label: 'Open requirements matrix' };
    case 'run_hardening':
      return ctx.latestSessionScript
        ? { ...scriptTab(ctx.latestSessionScript.scriptId, ctx.latestSessionScript.filename), label: 'Open session script' }
        : { ...FLOWCHART_TAB, label: 'Open script library', href: '/app/library' };
    case 'run_leads':
      return { ...REPORTS_TAB, label: 'Open LEADS reports' };
    case 'inspect_leads':
      return ctx.latestReport
        ? { ...CLAUDE_TAB, label: 'Send LEADS report to Claude', mode: 'remediation', refs: [{ type: 'leads_report', id: ctx.latestReport.id }] }
        : { ...CLAUDE_TAB, label: 'Send LEADS report to Claude', mode: 'remediation', disabledReason: 'Upload a LEADS report first' };
    case 'run_remediation': {
      // The latest remediation: its script once accepted, else its proposal to review; with none yet,
      // the latest report, where "Propose remediation" starts one.
      const r = ctx.latestRemediation;
      if (r?.status === 'accepted' && r.script) return { ...scriptTab(r.script.scriptId, r.script.filename), label: 'Open remediation script' };
      if (r) return { ...proposalTab(r.proposalId, r.title), label: 'Review remediation proposal' };
      return ctx.latestReport
        ? { ...reportTab(ctx.latestReport.id, ctx.latestReport.filename), label: 'Propose remediation from the latest report' }
        : { ...REPORTS_TAB, label: 'Propose remediation from the latest report', disabledReason: 'Upload a LEADS report first' };
    }
    case 'check_points':
      return { ...FLOWCHART_TAB, label: 'Open final point check', inspectorSection: 'points' };
    case 'submit_final':
      return { ...FLOWCHART_TAB, label: 'Open final submission', inspectorSection: 'submit' };
  }
}

/**
 * Performs a route in the browser: queues the Claude intent (if any), then opens/activates the tab.
 * Returns the href when the route is a navigation, so the caller can push it. Does nothing for a disabled route.
 */
export function openToolRoute(sessionId: string, route: ToolRoute): string | null {
  if (route.disabledReason) return null;
  if (route.href) return route.href;
  if (route.kind === 'claude' && route.mode) requestClaudeIntent(sessionId, { mode: route.mode, refs: route.refs ?? [] });
  const { key, kind, title, resourceId } = route;
  getWorkspaceStore(sessionId).getState().openTab(resourceId ? { key, kind, title, resourceId } : { key, kind, title });
  return null;
}
