// Client-safe flowchart definition (spec 8.1-8.3). Fixed layout: nodes are not draggable.
import type { StepKey, StepStatus } from '@/lib/types';
import { STEP_LABEL } from './stepMeta';

export const DECISION_ID = 'decision';

export const EDGE_LABELS = { completion: 'Completion condition', continue: 'Continue remediation' } as const;

export type FlowNodeDef =
  | { id: StepKey; kind: 'step'; step: StepKey; label: string; position: { x: number; y: number } }
  | { id: typeof DECISION_ID; kind: 'decision'; step?: undefined; label: string; position: { x: number; y: number } };

export type FlowEdgeDef = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  /** Distance the routed line keeps from its source node, so a label beside a node is not covered by it. */
  offset?: number;
};

export type FlowGraph = { nodes: FlowNodeDef[]; edges: FlowEdgeDef[] };

const COL = 0;
const BRANCH = -320;
const ROW = 104;
const at = (row: number, x = COL) => ({ x, y: row * ROW });

const step = (key: StepKey, row: number, x = COL): FlowNodeDef => ({ id: key, kind: 'step', step: key, label: STEP_LABEL[key], position: at(row, x) });
const edge = (source: string, target: string, extra: Partial<FlowEdgeDef> = {}): FlowEdgeDef => ({ id: `${source}->${target}`, source, target, ...extra });

export const FLOW_GRAPH: FlowGraph = {
  nodes: [
    step('open_readme', 0),
    step('claude_adaptation', 1),
    step('forensic_questions', 1, BRANCH),
    step('run_hardening', 2),
    step('run_leads', 3),
    step('inspect_leads', 4),
    step('run_remediation', 5),
    step('check_points', 6),
    // Spec 8.3: the branch conditions are unconfirmed, so the decision is conceptual only.
    { id: DECISION_ID, kind: 'decision', label: 'Final point check', position: at(7) },
    step('submit_final', 8),
  ],
  edges: [
    edge('open_readme', 'claude_adaptation'),
    // Parallel branch, tracked separately; rejoins before submit_final.
    edge('open_readme', 'forensic_questions', { sourceHandle: 'left-out', targetHandle: 'top' }),
    edge('forensic_questions', 'submit_final', { sourceHandle: 'bottom', targetHandle: 'left-in' }),
    edge('claude_adaptation', 'run_hardening'),
    edge('run_hardening', 'run_leads'),
    edge('run_leads', 'inspect_leads'),
    edge('inspect_leads', 'run_remediation'),
    edge('run_remediation', 'check_points'),
    edge('check_points', DECISION_ID),
    edge(DECISION_ID, 'submit_final', { label: EDGE_LABELS.completion }),
    edge(DECISION_ID, 'run_leads', { label: EDGE_LABELS.continue, sourceHandle: 'right-out', targetHandle: 'right-in', offset: 144 }),
  ],
};

/** Ids of edges that lead into an in-progress step: the active path. */
export function activeEdgeIds(graph: FlowGraph, status: ReadonlyMap<string, StepStatus>): Set<string> {
  return new Set(graph.edges.filter((e) => status.get(e.target) === 'in_progress').map((e) => e.id));
}
