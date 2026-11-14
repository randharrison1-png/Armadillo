'use client';

import { useState, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { STEP_STATUS_LABEL, type StepKey, type StepStatus } from '@/lib/types';
import { saveStepNotesAction, setStepStatusAction } from './actions';
import { STATUS_ICON, STATUS_TEXT_CLASS } from './statusUi';
import { STEP_LABEL } from './stepMeta';
import type { ToolRoute } from './toolRoutes';
import { EVIDENCE_STEPS, NOTE_MAX, type FlowEvent, type FlowEvidence, type FlowStep } from './types';

const STATUSES = Object.keys(STEP_STATUS_LABEL) as StepStatus[];
const KIND_LABEL: Record<string, string> = { execution_output: 'Execution output', screenshot: 'Screenshot', verification: 'Verification', other: 'Other' };
const SECTION_NOTE: Record<NonNullable<ToolRoute['inspectorSection']>, string> = {
  forensic: 'Forensic question tracking is not available yet. Track completion with the status and notes above.',
  points: 'Recording the final point count is not available yet. Record what you verified in the notes above.',
  submit: 'Final submission is not available yet. Record what you submitted in the notes above.',
};

const stamp = (iso: string) => `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso))} UTC`;

/** Wraps a disabled control so keyboard and pointer users can read why it is unavailable. */
function Gated({ reason, children }: { reason?: string; children: ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export const DECISION_UNAVAILABLE = 'Available after a LEADS report is checked';

/** Inspector body for the decision node: conceptual only (spec 8.3); never changes a status. */
export function DecisionPanel() {
  return (
    <div className="flex flex-col gap-4">
      <p>
        After the final point check, either the <span className="text-text">Completion condition</span> is met and you submit, or you{' '}
        <span className="text-text">Continue remediation</span> and return to the LEADS audit.
      </p>
      <p>The exact scoring conditions for each branch are not confirmed yet, so Armadillo does not decide this for you and never changes a step on its own.</p>
      <div className="flex flex-wrap gap-2">
        <Gated reason={DECISION_UNAVAILABLE}>
          <Button variant="secondary" disabled>
            Mark complete
          </Button>
        </Gated>
        <Gated reason={DECISION_UNAVAILABLE}>
          <Button variant="secondary" disabled>
            Start another cycle
          </Button>
        </Gated>
      </div>
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
  /** Called after a successful write so the tab reloads its data. */
  onChanged: () => void;
  onOpenTool: (route: ToolRoute) => void;
};

/** Inspector body for one step: status, notes, evidence, history and the tool action. */
export function NodePanel({ sessionId, step, state, evidence, events, route, readOnly, onChanged, onOpenTool }: Props) {
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
        {route.inspectorSection ? <p>{SECTION_NOTE[route.inspectorSection]}</p> : null}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="font-medium text-text">Evidence</h4>
        {evidence.length === 0 ? (
          <p>No evidence yet</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {evidence.map((e) => (
              <li key={e.id} className="border-b border-border pb-2">
                <span className="text-text">{KIND_LABEL[e.kind] ?? e.kind}</span> · {stamp(e.createdAt)}
                {e.note ? <p className="break-words">{e.note}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

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
