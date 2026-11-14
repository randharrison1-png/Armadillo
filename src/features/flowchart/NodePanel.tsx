'use client';

import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Gated } from '@/components/ui/gated';
import type { Availability, CycleDecision, DecisionAvailability } from '@/features/reports/remediationRules';
import { STEP_STATUS_LABEL, type StepKey, type StepStatus } from '@/lib/types';
import { PointsPanel, SubmitPanel } from '@/features/sessions/CompletionPanels';
import { EvidencePanel } from '@/features/sessions/EvidencePanel';
import { ForensicPanel } from '@/features/sessions/ForensicPanel';
import { decideCycleAction, saveStepNotesAction, setStepStatusAction } from './actions';
import { STATUS_ICON, STATUS_TEXT_CLASS } from './statusUi';
import { STEP_LABEL } from './stepMeta';
import type { ToolRoute } from './toolRoutes';
import { EVIDENCE_STEPS, NOTE_MAX, type FlowCycle, type FlowEvent, type FlowEvidence, type FlowScriptVersion, type FlowStep } from './types';

const STATUSES = Object.keys(STEP_STATUS_LABEL) as StepStatus[];
const stamp = (iso: string) => `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso))} UTC`;

const OUTCOME_LABEL: Record<FlowCycle['outcome'], string> = { open: 'Open', completed: 'Marked complete', continued: 'Continued to the next cycle' };

type DecisionProps = {
  sessionId: string;
  currentCycle: number;
  decision: DecisionAvailability;
  cycles: FlowCycle[];
  /** Called after a successful decision so the tab reloads its data. */
  onChanged: () => void;
};

const CONFIRM: Record<CycleDecision, { title: string; body: (cycle: number) => string; action: string }> = {
  complete: {
    title: 'Mark this audit cycle complete?',
    body: (n) => `Cycle ${n} is recorded as complete and “Submit final” moves to In Progress. Nothing is submitted for you; the session stays open until you finish it.`,
    action: 'Mark complete',
  },
  continue: {
    title: 'Start another audit cycle?',
    body: (n) =>
      `Cycle ${n} is closed and cycle ${n + 1} starts: Run LEADS, Inspect LEADS report, Targeted remediation and Check final points go back to Not Started. Reports, scripts, proposals and the step history of cycle ${n} are kept.`,
    action: 'Start another cycle',
  },
};

/**
 * Inspector body for the decision node (spec 8.3): the scoring conditions are not confirmed, so the
 * user decides. "Mark complete" needs Check final points Complete and Verified; "Start another
 * cycle" needs a LEADS report in this cycle. Disabled buttons explain why in a tooltip.
 */
export function DecisionPanel({ sessionId, currentCycle, decision, cycles, onChanged }: DecisionProps) {
  const [confirming, setConfirming] = useState<CycleDecision | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (choice: CycleDecision) => {
    setPending(true);
    setError(null);
    try {
      const r = await decideCycleAction({ sessionId, decision: choice });
      if (!r.ok) return setError(r.error);
      setConfirming(null);
      onChanged();
    } catch {
      setError('Could not record the decision. Try again.');
    } finally {
      setPending(false);
    }
  };
  const reason = (a: Availability) => (a.enabled ? undefined : a.reason);
  const shown = confirming ? CONFIRM[confirming] : null;

  return (
    <div className="flex flex-col gap-4">
      <p>
        After the final point check, either the <span className="text-text">Completion condition</span> is met and you submit, or you{' '}
        <span className="text-text">Continue remediation</span> and return to the LEADS audit.
      </p>
      <p>The exact scoring conditions for each branch are not confirmed yet, so Armadillo does not decide this for you and never changes a step on its own.</p>
      <p className="text-text">Current cycle: {currentCycle}</p>
      <div className="flex flex-wrap gap-2">
        <Gated reason={reason(decision.complete)}>
          <Button variant="secondary" disabled={!decision.complete.enabled || pending} onClick={() => (setError(null), setConfirming('complete'))}>
            Mark complete
          </Button>
        </Gated>
        <Gated reason={reason(decision.continue)}>
          <Button variant="secondary" disabled={!decision.continue.enabled || pending} onClick={() => (setError(null), setConfirming('continue'))}>
            Start another cycle
          </Button>
        </Gated>
      </div>
      {error && !confirming ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
      <section aria-label="Audit cycles" className="flex flex-col gap-2">
        <h4 className="text-small font-semibold text-text">Cycle history</h4>
        {cycles.length === 0 ? (
          <p>No cycle has been closed or remediated yet.</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {cycles.map((c) => (
              <li key={c.cycleNo}>
                <span className="text-text">Cycle {c.cycleNo}</span> · {OUTCOME_LABEL[c.outcome]}
                {c.reportFilename ? ` · report ${c.reportFilename}` : ''}
                {c.points !== null ? ` · reported points ${c.points}${c.targetPoints !== null ? ` of ${c.targetPoints}` : ''}` : ''}
              </li>
            ))}
          </ol>
        )}
      </section>
      <Dialog open={!!confirming} onOpenChange={(open) => !open && !pending && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{shown?.title}</DialogTitle>
            <DialogDescription>{shown?.body(currentCycle)}</DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-small text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirming(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={() => confirming && void decide(confirming)} loading={pending}>
              {shown?.action}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type Props = {
  sessionId: string;
  step: StepKey;
  state: FlowStep;
  evidence: FlowEvidence[];
  events: FlowEvent[];
  route: ToolRoute;
  readOnly: boolean;
  currentCycle: number;
  scriptVersions: FlowScriptVersion[];
  forensic: { total: number; answered: number };
  points: { points: number | null; target: number | null };
  completedAt: string | null;
  /** Called after a successful write so the tab reloads its data. */
  onChanged: () => void;
  onOpenTool: (route: ToolRoute) => void;
};

/** Inspector body for one step: status, notes, evidence, history and the tool action. */
export function NodePanel({ sessionId, step, state, evidence, events, route, readOnly, currentCycle, scriptVersions, forensic, points, completedAt, onChanged, onOpenTool }: Props) {
  const [pending, setPending] = useState<'status' | 'notes' | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState(state.notes ?? '');
  const [synced, setSynced] = useState(state.notes ?? '');

  // Follow saved notes (e.g. after a reload) unless the user has unsaved edits.
  const incoming = state.notes ?? '';
  if (incoming !== synced) {
    setSynced(incoming);
    if (draft === synced) setDraft(incoming);
  }

  const changeStatus = async (status: StepStatus) => {
    if (status === state.status) return;
    setPending('status');
    setStatusError(null);
    try {
      const r = await setStepStatusAction({ sessionId, step, status });
      if (r.ok) onChanged();
      else setStatusError(r.error);
    } catch {
      setStatusError('Could not save the status. Try again.');
    } finally {
      setPending(null);
    }
  };

  const saveNotes = async () => {
    setPending('notes');
    setNotesError(null);
    setSaved(false);
    try {
      const r = await saveStepNotesAction({ sessionId, step, notes: draft });
      if (r.ok) {
        setSaved(true);
        onChanged();
      } else setNotesError(r.error);
    } catch {
      setNotesError('Could not save the notes. Try again.');
    } finally {
      setPending(null);
    }
  };

  const Icon = STATUS_ICON[state.status];
  const gate = route.disabledReason;
  const dirty = draft !== (state.notes ?? '');

  return (
    <div className="flex flex-col gap-4" data-testid="node-panel">
      <div className="flex flex-col gap-2">
        <label htmlFor={`status-${step}`} className="font-medium text-text">
          Status
        </label>
        <Select value={state.status} onValueChange={(v) => void changeStatus(v as StepStatus)} disabled={readOnly || pending === 'status'}>
          <SelectTrigger id={`status-${step}`} aria-label="Status" aria-invalid={statusError ? true : undefined}>
            <span className={`flex items-center gap-2 ${STATUS_TEXT_CLASS[state.status]}`}>
              <Icon aria-hidden className="size-4" />
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STEP_STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {pending === 'status' ? <p role="status">Saving status…</p> : null}
        {statusError ? (
          <p role="alert" className="text-danger">
            {statusError}
          </p>
        ) : null}
        {EVIDENCE_STEPS.includes(step) ? (
          <p>Complete and Verified needs evidence for this step in the current cycle. Armadillo refuses it until some is attached.</p>
        ) : (
          <p>You can mark this step Complete and Verified yourself.</p>
        )}
        {readOnly ? <p>This session is completed and read-only.</p> : null}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`notes-${step}`} className="font-medium text-text">
          Notes
        </label>
        <Textarea
          id={`notes-${step}`}
          rows={4}
          maxLength={NOTE_MAX}
          value={draft}
          readOnly={readOnly}
          onChange={(e) => {
            setDraft(e.target.value);
            setSaved(false);
          }}
        />
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => void saveNotes()} disabled={readOnly || !dirty} loading={pending === 'notes'}>
            Save notes
          </Button>
          {saved && !dirty ? <span role="status">Saved</span> : null}
        </div>
        {notesError ? (
          <p role="alert" className="text-danger">
            {notesError}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="font-medium text-text">Tool</h4>
        <div>
          <Gated reason={gate}>
            <Button variant="primary" disabled={!!gate} onClick={() => onOpenTool(route)}>
              <ExternalLink aria-hidden className="size-4" />
              {route.label}
            </Button>
          </Gated>
        </div>
      </div>

      {route.inspectorSection === 'forensic' ? <ForensicPanel sessionId={sessionId} /> : null}
      {route.inspectorSection === 'points' ? <PointsPanel sessionId={sessionId} currentCycle={currentCycle} points={points} readOnly={readOnly} onChanged={onChanged} /> : null}
      {route.inspectorSection === 'submit' ? <SubmitPanel sessionId={sessionId} forensic={forensic} completedAt={completedAt} onChanged={onChanged} /> : null}

      <EvidencePanel sessionId={sessionId} step={step} evidence={evidence} currentCycle={currentCycle} scriptVersions={scriptVersions} readOnly={readOnly} onChanged={onChanged} />

      <div className="flex flex-col gap-2">
        <h4 className="font-medium text-text">History</h4>
        {events.length === 0 ? (
          <p>No status changes yet</p>
        ) : (
          <ol className="flex flex-col gap-2" aria-label={`${STEP_LABEL[step]} history`}>
            {events.map((e) => (
              <li key={e.id} className="border-b border-border pb-2">
                <span className="text-text">
                  {e.fromStatus ? `${STEP_STATUS_LABEL[e.fromStatus]} → ` : ''}
                  {STEP_STATUS_LABEL[e.toStatus]}
                </span>
                <br />
                Cycle {e.cycleNo} · {stamp(e.createdAt)}
                {e.note ? <p className="break-words">{e.note}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
