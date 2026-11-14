import { beforeEach, describe, expect, it } from 'vitest';
import { STEP_ORDER } from '@/features/flowchart/stepMeta';
import { activeEdgeIds, DECISION_ID, FLOW_GRAPH } from '@/features/flowchart/graph';
import { toolRouteFor, type ToolContext } from '@/features/flowchart/toolRoutes';
import { consumeClaudeIntent, requestClaudeIntent, useClaudeIntent } from '@/features/claude/claudeIntent';
import { getContextStore, resetContextStores } from '@/features/claude/contextSelection';
import { STEP_STATUS_LABEL } from '@/lib/types';

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  sessionId: 's1',
  latestReport: { id: 'r-latest', filename: 'leads.txt' },
  latestSessionScript: { scriptId: 'sc1', filename: 'harden.ps1' },
  ...over,
});

describe('FLOW_GRAPH', () => {
  const edge = (s: string, t: string) => FLOW_GRAPH.edges.find((e) => e.source === s && e.target === t);

  it('has one node per step plus the decision, and the main sequence in spec 8.1 order', () => {
    const steps = FLOW_GRAPH.nodes.filter((n) => n.kind === 'step').map((n) => n.step);
    expect([...steps].sort()).toEqual([...STEP_ORDER].sort());
    const main = ['open_readme', 'claude_adaptation', 'run_hardening', 'run_leads', 'inspect_leads', 'run_remediation', 'check_points', DECISION_ID];
    for (let i = 0; i < main.length - 1; i++) expect(edge(main[i]!, main[i + 1]!)).toBeTruthy();
  });

  it('branches forensic_questions from open_readme and rejoins before submit_final', () => {
    expect(edge('open_readme', 'forensic_questions')).toBeTruthy();
    expect(edge('forensic_questions', 'submit_final')).toBeTruthy();
  });

  it('labels the decision edges and loops back to run_leads', () => {
    expect(edge(DECISION_ID, 'submit_final')?.label).toBe('Completion condition');
    expect(edge(DECISION_ID, 'run_leads')?.label).toBe('Continue remediation');
  });

  it('marks edges into in-progress nodes as the active path', () => {
    const status = new Map([['run_hardening', 'in_progress'] as const]);
    const ids = activeEdgeIds(FLOW_GRAPH, status);
    expect(ids).toEqual(new Set([edge('claude_adaptation', 'run_hardening')!.id]));
  });

  it('uses the exact status labels', () => {
    expect(Object.values(STEP_STATUS_LABEL)).toEqual(['Not Started', 'In Progress', 'Complete and Verified', 'Blocked/Needs Review']);
  });
});

describe('toolRouteFor', () => {
  it('routes each step to its tool', () => {
    expect(toolRouteFor('open_readme', ctx())).toMatchObject({ kind: 'readme' });
    expect(toolRouteFor('claude_adaptation', ctx())).toMatchObject({ kind: 'requirements' });
    expect(toolRouteFor('run_hardening', ctx())).toMatchObject({ kind: 'script', resourceId: 'sc1' });
    expect(toolRouteFor('run_leads', ctx())).toMatchObject({ kind: 'report' });
    expect(toolRouteFor('run_remediation', ctx())).toMatchObject({ kind: 'requirements' });
  });

  it('falls back to the library when the session has no script', () => {
    const r = toolRouteFor('run_hardening', ctx({ latestSessionScript: null }));
    expect(r.href).toBe('/app/library');
  });

  it('inspect_leads opens the Claude tab in remediation mode with the latest report selected', () => {
    const r = toolRouteFor('inspect_leads', ctx());
    expect(r).toMatchObject({ key: 'claude', kind: 'claude', mode: 'remediation', label: 'Send LEADS report to Claude' });
    expect(r.refs).toEqual([{ type: 'leads_report', id: 'r-latest' }]);
    expect(r.disabledReason).toBeUndefined();
  });

  it('inspect_leads is disabled with a reason when no report exists', () => {
    const r = toolRouteFor('inspect_leads', ctx({ latestReport: null }));
    expect(r.disabledReason).toBe('Upload a LEADS report first');
    expect(r.refs).toBeUndefined();
  });

  it('forensic, check_points and submit_final route to explicit inspector sections', () => {
    expect(toolRouteFor('forensic_questions', ctx())).toMatchObject({ kind: 'flowchart', inspectorSection: 'forensic' });
    expect(toolRouteFor('check_points', ctx())).toMatchObject({ kind: 'flowchart', inspectorSection: 'points' });
    expect(toolRouteFor('submit_final', ctx())).toMatchObject({ kind: 'flowchart', inspectorSection: 'submit' });
  });

  it('every step has a route', () => {
    for (const s of STEP_ORDER) expect(toolRouteFor(s, ctx()).label.length).toBeGreaterThan(0);
  });
});

describe('Claude intent', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetContextStores();
    useClaudeIntent.setState({ pending: {} });
  });

  it('is consumed once: refs are selected and the mode is returned', () => {
    requestClaudeIntent('s1', { mode: 'remediation', refs: [{ type: 'leads_report', id: 'r1' }] });
    expect(consumeClaudeIntent('s1')).toEqual({ mode: 'remediation' });
    expect(getContextStore('s1').getState().refs).toEqual([{ type: 'leads_report', id: 'r1' }]);
    expect(consumeClaudeIntent('s1')).toBeNull();
    expect(getContextStore('s1').getState().refs).toHaveLength(1);
  });

  it('is per session', () => {
    requestClaudeIntent('s1', { mode: 'remediation', refs: [{ type: 'leads_report', id: 'r1' }] });
    expect(consumeClaudeIntent('s2')).toBeNull();
    expect(getContextStore('s2').getState().refs).toEqual([]);
  });
});
