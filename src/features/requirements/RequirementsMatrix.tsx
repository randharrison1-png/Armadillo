'use client';

import { useId, useState } from 'react';
import { AlertTriangle, CircleCheck, CircleDashed, CircleDot, FileText, Pencil, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { Coverage, WorkState } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  CATEGORY_LABEL,
  countRows,
  COVERAGE_HINT,
  COVERAGE_LABEL,
  COVERAGES,
  filterRows,
  isShownVerified,
  sourceLabel,
  WORK_STATE_HINT,
  WORK_STATE_LABEL,
  WORK_STATES,
  type MatrixFilters,
} from './matrix';
import type { ActionError, NotesOutcome, RequirementRow } from './types';

export const NOTES_MAX = 4000;

type Props = {
  rows: RequirementRow[];
  readOnly: boolean;
  onOpenSource: (row: RequirementRow) => void;
  onSaveNotes: (id: string, notes: string) => Promise<NotesOutcome | ActionError>;
};

const STATE_ICON: Record<WorkState, LucideIcon> = { proposed: CircleDashed, reported: CircleDot, verified: CircleCheck };

/**
 * The requirements matrix: Requirement · Source · Coverage · State · Notes, with coverage/state
 * filters and summary counts. Coverage is Claude's reading of a script; State is what was done
 * (Proposed / Reported / Verified). "Verified" is only ever shown with its evidence report.
 */
export function RequirementsMatrix({ rows, readOnly, onOpenSource, onSaveNotes }: Props) {
  const [filters, setFilters] = useState<MatrixFilters>({ coverage: 'all', state: 'all' });
  const id = useId();
  const counts = countRows(rows);
  const shown = filterRows(rows, filters);

  return (
    <div className="flex flex-col gap-4">
      <div data-testid="requirements-summary" className="flex flex-col gap-1 text-small text-muted">
        <p>
          <span className="font-semibold text-text">
            {counts.total} {counts.total === 1 ? 'requirement' : 'requirements'}
          </span>
        </p>
        <ul aria-label="By coverage" className="flex flex-wrap gap-x-4 gap-y-1">
          {COVERAGES.map((c) => (
            <li key={c}>
              {COVERAGE_LABEL[c]} <span className="text-text">{counts.coverage[c]}</span>
            </li>
          ))}
        </ul>
        <ul aria-label="By state" className="flex flex-wrap gap-x-4 gap-y-1">
          {WORK_STATES.map((s) => (
            <li key={s}>
              {WORK_STATE_LABEL[s]} <span className="text-text">{counts.state[s]}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1 text-small text-muted">
          <label htmlFor={`${id}-coverage`}>Coverage</label>
          <select
            id={`${id}-coverage`}
            className={cn(fieldClass, 'h-control w-48')}
            value={filters.coverage}
            onChange={(e) => setFilters((f) => ({ ...f, coverage: e.target.value as Coverage | 'all' }))}
          >
            <option value="all">All coverage</option>
            {COVERAGES.map((c) => (
              <option key={c} value={c}>
                {COVERAGE_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 text-small text-muted">
          <label htmlFor={`${id}-state`}>State</label>
          <select
            id={`${id}-state`}
            className={cn(fieldClass, 'h-control w-48')}
            value={filters.state}
            onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value as WorkState | 'all' }))}
          >
            <option value="all">All states</option>
            {WORK_STATES.map((s) => (
              <option key={s} value={s}>
                {WORK_STATE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="overflow-x-auto rounded-sm border border-border">
        <table aria-label="Requirements" className="w-full border-collapse text-left text-small">
          <thead className="bg-surface text-muted">
            <tr>
              {['Requirement', 'Source', 'Coverage', 'State', 'Notes'].map((h) => (
                <th key={h} scope="col" className="border-b border-border px-2 py-2 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <MatrixRow key={r.id} row={r} readOnly={readOnly} onOpenSource={onOpenSource} onSaveNotes={onSaveNotes} />
            ))}
          </tbody>
        </table>
        {shown.length === 0 ? <p className="p-4 text-center text-small text-muted">No requirements match these filters.</p> : null}
      </div>
    </div>
  );
}

function MatrixRow({ row: r, readOnly, onOpenSource, onSaveNotes }: { row: RequirementRow } & Omit<Props, 'rows'>) {
  const source = sourceLabel(r.sourceKind, r.sourceIndex);
  return (
    <tr className="align-top transition-colors duration-150 hover:bg-surface">
      <td className="border-b border-border px-2 py-2">
        <p className="break-words text-body text-text">{r.text}</p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
          {r.category ? <span>{CATEGORY_LABEL[r.category] ?? r.category}</span> : null}
          {r.disruptive ? (
            <span data-testid="disruptive-marker" className="inline-flex items-center gap-1 text-warning" title="Potentially disruptive: review it explicitly before running anything.">
              <AlertTriangle aria-hidden className="size-4 shrink-0" />
              Needs review
            </span>
          ) : null}
        </p>
        {r.suggestion ? (
          <p className="mt-1 break-words text-muted">
            <span className="text-text">Suggested change:</span> <span className="font-mono">{r.suggestion}</span>
          </p>
        ) : null}
      </td>
      <td className="border-b border-border px-2 py-2 whitespace-nowrap">
        <Button
          variant="ghost"
          className="h-control-sm px-2"
          disabled={r.sourceKind === null}
          aria-label={r.sourceKind === null ? 'Source section not found in the README' : `Open ${source} in the README`}
          onClick={() => onOpenSource(r)}
        >
          <FileText aria-hidden className="size-4" />
          {source}
        </Button>
      </td>
      <td className="border-b border-border px-2 py-2" title={COVERAGE_HINT[r.coverage]}>
        <p className={cn('text-text', r.coverage === 'missing' && 'text-danger', r.coverage === 'needs_review' && 'text-warning')}>{COVERAGE_LABEL[r.coverage]}</p>
        {r.scriptLabel && r.coverage !== 'detected' ? <p className="text-muted">Script: {r.scriptLabel}</p> : null}
      </td>
      <td className="border-b border-border px-2 py-2">
        <StateCell row={r} />
      </td>
      <td className="border-b border-border px-2 py-2">
        <NoteCell row={r} readOnly={readOnly} onSaveNotes={onSaveNotes} />
      </td>
    </tr>
  );
}

function StateCell({ row: r }: { row: RequirementRow }) {
  // Audit accuracy: Verified is shown only with the evidence report it rests on.
  const state: WorkState = r.workState === 'verified' && !isShownVerified(r) ? 'reported' : r.workState;
  const Icon = STATE_ICON[state];
  return (
    <div title={WORK_STATE_HINT[state]}>
      <p className={cn('inline-flex items-center gap-1 text-text', state === 'verified' && 'text-accent')}>
        <Icon aria-hidden className="size-4 shrink-0" />
        <span>{r.workState === 'verified' && state !== 'verified' ? 'Not verified (evidence missing)' : WORK_STATE_LABEL[state]}</span>
      </p>
      {state === 'verified' ? <p className="text-muted">Evidence: {r.evidenceLabel ?? `report ${r.evidenceReportId?.slice(0, 8)}`}</p> : null}
      {state === 'reported' && r.workState === 'reported' ? <p className="text-muted">Not yet verified</p> : null}
    </div>
  );
}

function NoteCell({ row: r, readOnly, onSaveNotes }: { row: RequirementRow; readOnly: boolean; onSaveNotes: Props['onSaveNotes'] }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(r.notes ?? '');
  const [notes, setNotes] = useState(r.notes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState(r.notes);
  if (seen !== r.notes) {
    // Fresh data from the server (e.g. after a reload) replaces what this cell showed.
    setSeen(r.notes);
    setNotes(r.notes);
  }

  if (editing) {
    return (
      <form
        className="flex min-w-48 flex-col gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          const res = await onSaveNotes(r.id, draft).catch(() => ({ ok: false as const, error: 'Could not save the note. Try again.' }));
          setSaving(false);
          if (!res.ok) return setError(res.error);
          setNotes(res.notes);
          setEditing(false);
        }}
      >
        <Textarea
          aria-label={`Note for requirement: ${r.text}`}
          value={draft}
          maxLength={NOTES_MAX}
          rows={3}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" loading={saving} className="h-control-sm px-2">
            Save note
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-control-sm px-2"
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="flex min-w-32 flex-col items-start gap-1">
      {notes ? <p className="whitespace-pre-wrap break-words text-text">{notes}</p> : <p className="text-muted">—</p>}
      {readOnly ? null : (
        <Button
          variant="ghost"
          className="h-control-sm px-2"
          aria-label={`${notes ? 'Edit note for' : 'Add note to'} requirement: ${r.text}`}
          onClick={() => {
            setDraft(notes ?? '');
            setEditing(true);
          }}
        >
          <Pencil aria-hidden className="size-4" />
          {notes ? 'Edit note' : 'Add note'}
        </Button>
      )}
    </div>
  );
}
