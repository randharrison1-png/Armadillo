'use client';

import '@xyflow/react/dist/base.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { GitBranch, Split } from 'lucide-react';
import { SetTabInspector, useInspectorStore } from '@/components/shell/inspectorStore';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { ErrorState } from '@/components/shell/states/ErrorState';
import { LoadingState } from '@/components/shell/states/LoadingState';
import { cn } from '@/lib/utils';
import { STEP_STATUS_LABEL, type StepKey, type StepStatus, type TabDescriptor } from '@/lib/types';
import { loadFlowchart } from './actions';
import { activeEdgeIds, DECISION_ID, FLOW_GRAPH, type FlowNodeDef } from './graph';
import { DecisionPanel, NodePanel } from './NodePanel';
import { STATUS_ICON, STATUS_TEXT_CLASS } from './statusUi';
import { STEP_LABEL, STEP_ORDER } from './stepMeta';
import { openToolRoute, toolRouteFor, type ToolRoute } from './toolRoutes';
import type { FlowchartData } from './types';

type StepNodeData = {
  def: FlowNodeDef;
  status?: StepStatus;
  selected: boolean;
  route?: ToolRoute;
  onSelect: () => void;
  onOpenTool: (route: ToolRoute) => void;
};
type FlowNode = Node<StepNodeData, 'step' | 'decision'>;

const HANDLE = '!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent';

function Handles() {
  return (
    <>
      <Handle id="top" type="target" position={Position.Top} className={HANDLE} />
      <Handle id="bottom" type="source" position={Position.Bottom} className={HANDLE} />
      <Handle id="left-out" type="source" position={Position.Left} className={HANDLE} />
      <Handle id="left-in" type="target" position={Position.Left} className={HANDLE} style={{ top: '70%' }} />
      <Handle id="right-out" type="source" position={Position.Right} className={HANDLE} />
      <Handle id="right-in" type="target" position={Position.Right} className={HANDLE} style={{ top: '30%' }} />
    </>
  );
}

function StepNode({ data }: NodeProps<FlowNode>) {
  const { def, status = 'not_started', selected, route, onSelect, onOpenTool } = data;
  const Icon = STATUS_ICON[status];
  return (
    <div
      className={cn(
        'w-60 rounded-sm border bg-surface',
        status === 'in_progress' ? 'border-accent' : 'border-border',
        selected && 'ring-2 ring-text/60',
      )}
    >
      <Handles />
      <button
        type="button"
        onClick={onSelect}
        aria-label={`${def.label}, ${STEP_STATUS_LABEL[status]}`}
        aria-pressed={selected}
        className="nodrag nopan flex w-full flex-col gap-1 rounded-t-sm p-2 text-left transition-colors duration-150 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        <span className="text-small font-medium text-text">{def.label}</span>
        <span className={cn('flex items-center gap-2 text-small', STATUS_TEXT_CLASS[status])}>
          <Icon aria-hidden className="size-4 shrink-0" />
          {STEP_STATUS_LABEL[status]}
        </span>
      </button>
      {route ? (
        <button
          type="button"
          aria-disabled={route.disabledReason ? true : undefined}
          title={route.disabledReason}
          onClick={() => !route.disabledReason && onOpenTool(route)}
          className={cn(
            'nodrag nopan w-full rounded-b-sm border-t border-border px-2 py-1 text-left text-small transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
            route.disabledReason ? 'cursor-not-allowed text-muted' : 'text-accent hover:bg-surface-raised',
          )}
        >
          {route.label}
        </button>
      ) : null}
    </div>
  );
}

function DecisionNode({ data }: NodeProps<FlowNode>) {
  const { def, selected, onSelect } = data;
  return (
    <div className={cn('w-60 rounded-sm border border-dashed border-border bg-bg', selected && 'ring-2 ring-text/60')}>
      <Handles />
      <button
        type="button"
        onClick={onSelect}
        aria-label={`${def.label}, decision`}
        aria-pressed={selected}
        className="nodrag nopan flex w-full items-center gap-2 rounded-sm p-2 text-left transition-colors duration-150 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        <Split aria-hidden className="size-4 shrink-0 text-muted" />
        <span className="flex flex-col">
          <span className="text-small font-medium text-text">{def.label}</span>
          <span className="text-small text-muted">Decision</span>
        </span>
      </button>
    </div>
  );
}

const nodeTypes = { step: StepNode, decision: DecisionNode };

const FIT = { padding: 0.08 };

/** The graph. Refits whenever its box resizes (the inspector opening or closing changes the width). */
function Canvas({ nodes, edges }: { nodes: FlowNode[]; edges: Edge[] }) {
  const flow = useReactFlow();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => void flow.fitView(FIT));
    ro.observe(el);
    return () => ro.disconnect();
  }, [flow]);
  return (
    <div ref={box} className="relative h-[1000px] w-full" data-testid="flow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={FIT}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        preventScrolling={false}
        minZoom={0.5}
        maxZoom={1.25}
        proOptions={{ hideAttribution: true }}
        aria-label="Hardening flowchart"
      />
    </div>
  );
}

type Load = { state: 'loading' } | { state: 'error' } | { state: 'missing' } | { state: 'ready'; data: FlowchartData };

/** Body of a session's flowchart tab: the per-session map of the hardening process. */
export function FlowchartTab({ namespace: sessionId }: { namespace: string; tab: TabDescriptor }) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const setInspectorOpen = useInspectorStore((s) => s.setOpen);

  const reload = useCallback(() => {
    loadFlowchart(sessionId).then(
      (data) => {
        setLoad(data ? { state: 'ready', data } : { state: 'missing' });
        setRevision((n) => n + 1);
      },
      () => setLoad((l) => (l.state === 'ready' ? l : { state: 'error' })),
    );
  }, [sessionId]);
  useEffect(() => reload(), [reload]);

  const ctx = useMemo(
    () =>
      load.state === 'ready'
        ? { sessionId, latestReport: load.data.latestReport, latestSessionScript: load.data.latestSessionScript }
        : null,
    [load, sessionId],
  );
  const routeOf = useCallback((step: StepKey) => (ctx ? toolRouteFor(step, ctx) : undefined), [ctx]);

  const select = useCallback(
    (id: string) => {
      setSelected(id);
      setInspectorOpen(true);
    },
    [setInspectorOpen],
  );
  const openTool = useCallback(
    (route: ToolRoute) => {
      const href = openToolRoute(sessionId, route);
      if (href) router.push(href);
    },
    [router, sessionId],
  );

  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });
  const onChanged = useCallback(() => reloadRef.current(), []);

  const status = useMemo(() => {
    const m = new Map<string, StepStatus>();
    if (load.state === 'ready') for (const s of load.data.steps) m.set(s.step, s.status);
    return m;
  }, [load]);

  const nodes = useMemo<FlowNode[]>(
    () =>
      FLOW_GRAPH.nodes.map((def) => ({
        id: def.id,
        type: def.kind,
        position: def.position,
        draggable: false,
        selectable: false,
        focusable: false,
        // Not draggable or selectable, so React Flow would make the wrapper pointer-events: none; the buttons inside must stay clickable.
        style: { pointerEvents: 'all' as const },
        data: {
          def,
          status: def.kind === 'step' ? (status.get(def.id) ?? 'not_started') : undefined,
          selected: selected === def.id,
          route: def.kind === 'step' ? routeOf(def.step) : undefined,
          onSelect: () => select(def.id),
          onOpenTool: openTool,
        },
      })),
    [status, selected, routeOf, select, openTool],
  );

  const edges = useMemo<Edge[]>(() => {
    const active = activeEdgeIds(FLOW_GRAPH, status);
    return FLOW_GRAPH.edges.map(({ offset, ...e }) => ({
      ...e,
      type: 'smoothstep',
      pathOptions: offset ? { offset } : undefined,
      focusable: false,
      selectable: false,
      style: { stroke: active.has(e.id) ? 'var(--accent)' : 'var(--border)', strokeWidth: 1 },
      labelStyle: { fill: 'var(--text)', fontSize: 14 },
      labelBgStyle: { fill: 'var(--bg)', fillOpacity: 1 },
      labelBgPadding: [8, 4] as [number, number],
    }));
  }, [status]);

  const ready = load.state === 'ready' ? load.data : null;
  const readOnly = ready?.sessionStatus === 'completed';

  const sections = useMemo(() => {
    if (!ready || !selected) return [];
    if (selected === DECISION_ID) return [{ id: 'flow-node', title: 'Decision: final point check', content: <DecisionPanel /> }];
    const step = selected as StepKey;
    const state = ready.steps.find((s) => s.step === step);
    const route = routeOf(step);
    if (!state || !route) return [];
    return [
      {
        id: 'flow-node',
        title: `Step: ${STEP_LABEL[step]}`,
        content: (
          <NodePanel
            key={step}
            sessionId={sessionId}
            step={step}
            state={state}
            evidence={ready.evidence.filter((e) => e.step === step)}
            events={ready.events.filter((e) => e.step === step)}
            route={route}
            readOnly={!!readOnly}
            onChanged={onChanged}
            onOpenTool={openTool}
          />
        ),
      },
    ];
  }, [ready, selected, routeOf, sessionId, readOnly, onChanged, openTool]);

  if (load.state === 'loading') return <LoadingState label="Loading flowchart" />;
  if (load.state === 'error') {
    return <ErrorState title="Could not load the flowchart" detail="Check your connection and try again." onRetry={() => (setLoad({ state: 'loading' }), reload())} />;
  }
  if (load.state === 'missing') return <EmptyState icon={GitBranch} title="Session not found" description="This session no longer exists." />;

  const byStep = new Map(load.data.steps.map((s) => [s.step, s]));

  return (
    <div className="flex min-h-full flex-col">
      <SetTabInspector sections={sections} version={`${selected ?? ''}|${revision}`} />
      <div className="shrink-0 border-b border-border px-4 py-2 text-small text-muted">
        Hardening flowchart · Cycle {load.data.currentCycle}. Select a step to see its status, notes, evidence and history in the inspector.
      </div>
      <ReactFlowProvider>
        <Canvas nodes={nodes} edges={edges} />
      </ReactFlowProvider>
      <ol className="sr-only" aria-label="Hardening steps">
        {STEP_ORDER.map((step) => (
          <li key={step}>
            {STEP_LABEL[step]}: {STEP_STATUS_LABEL[byStep.get(step)?.status ?? 'not_started']}
          </li>
        ))}
      </ol>
    </div>
  );
}
