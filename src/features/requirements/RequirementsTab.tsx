'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { FileDiff, ListChecks, ScanSearch, Sparkles, X } from 'lucide-react';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { ErrorState } from '@/components/shell/states/ErrorState';
import { LoadingState } from '@/components/shell/states/LoadingState';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fieldClass } from '@/components/ui/input';
import { openSegment, useReadmeUi } from '@/features/readme/readmeUi';
import { useProposeAdaptation } from '@/features/proposals/useProposeAdaptation';
import type { TabDescriptor } from '@/lib/types';
import { cn } from '@/lib/utils';
import { assessCoverageAction, extractRequirementsAction, loadRequirementsView, markRequirementReviewed, saveRequirementNotes } from './actions';
import { droppedMessage } from './matrix';
import { RequirementsMatrix } from './RequirementsMatrix';
import type { RequirementRow, RequirementsView } from './types';

type Load = { state: 'loading' } | { state: 'error' } | { state: 'missing' } | { state: 'ready'; view: RequirementsView };
type Banner = { kind: 'status' | 'error'; lines: string[] };
type Running = 'extract' | 'assess' | null;

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Body of the 'requirements' workspace tab: the README requirements matrix with its two Claude
 * actions, "Extract requirements" (choose a README if there are several; confirm before replacing)
 * and "Assess coverage" (choose a script version). Claude's assessment never changes a
 * requirement's state; the State column only moves with execution output and evidence.
 */
export function RequirementsTab({ namespace: sessionId }: { namespace: string; tab: TabDescriptor }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [running, setRunning] = useState<Running>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [extractOpen, setExtractOpen] = useState(false);
  const [assessOpen, setAssessOpen] = useState(false);
  const [proposeOpen, setProposeOpen] = useState(false);
  const proposer = useProposeAdaptation(sessionId);
  const readmeVersion = useReadmeUi((s) => s.version[sessionId] ?? 0);

  const reload = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    let cancelled = false;
    loadRequirementsView(sessionId).then(
      (view) => !cancelled && setLoad(view ? { state: 'ready', view } : { state: 'missing' }),
      () => !cancelled && setLoad((l) => (l.state === 'ready' ? l : { state: 'error' })),
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, attempt, readmeVersion]);

  if (load.state === 'loading') return <LoadingState label="Loading requirements" />;
  if (load.state === 'error') return <ErrorState title="Could not load the requirements" detail="Check your connection and try again." onRetry={() => (setLoad({ state: 'loading' }), reload())} />;
  if (load.state === 'missing') return <EmptyState icon={ListChecks} title="Requirements not found" description="This session no longer exists." />;

  const view = load.view;
  const completed = view.sessionStatus === 'completed';
  const rows = view.requirements;
  const latest = view.readmes[0] ?? null;
  const proposed = rows.filter((r) => r.workState === 'proposed').length;

  const runExtract = async (readmeId: string) => {
    setExtractOpen(false);
    setRunning('extract');
    setBanner(null);
    const res = await extractRequirementsAction({ sessionId, readmeId }).catch(() => ({ ok: false as const, error: 'Could not reach the server. Try again.' }));
    setRunning(null);
    if (!res.ok) return setBanner({ kind: 'error', lines: [res.error] });
    const lines = [`Extracted ${n(res.inserted, 'requirement', 'requirements')}.`];
    if (res.replaced) lines.push(`${n(res.replaced, 'earlier proposed requirement was', 'earlier proposed requirements were')} replaced.`);
    if (res.kept) lines.push(`${n(res.kept, 'earlier requirement was', 'earlier requirements were')} kept (reported, verified or with notes).`);
    const dropped = droppedMessage(res.dropped);
    if (dropped) lines.push(`${dropped}.`);
    if (res.trimmed) lines.push('The README was too long to send in full; requirements near its end may be missing.');
    setBanner({ kind: 'status', lines });
    reload();
  };

  const runAssess = async (scriptVersionId: string) => {
    setAssessOpen(false);
    setRunning('assess');
    setBanner(null);
    const res = await assessCoverageAction({ sessionId, scriptVersionId }).catch(() => ({ ok: false as const, error: 'Could not reach the server. Try again.' }));
    setRunning(null);
    if (!res.ok) return setBanner({ kind: 'error', lines: [res.error] });
    const lines = [`Assessed ${n(res.assessed, 'requirement', 'requirements')} against ${res.scriptLabel}. This is Claude's reading of the script, not verification.`];
    if (res.ignored) lines.push(`${n(res.ignored, 'item from Claude was', 'items from Claude were')} ignored because ${res.ignored === 1 ? 'it' : 'they'} named no listed requirement.`);
    if (res.unassessed) lines.push(`${n(res.unassessed, 'requirement was', 'requirements were')} not assessed and ${res.unassessed === 1 ? 'is' : 'are'} back to Detected.`);
    if (res.skipped) lines.push(`${n(res.skipped, 'reported or verified requirement was', 'reported or verified requirements were')} left unchanged.`);
    if (res.trimmed) lines.push('The README or script was too long to send in full; the assessment may be incomplete.');
    setBanner({ kind: 'status', lines });
    reload();
  };

  const runPropose = async (input: { readmeId: string; scriptVersionId: string }) => {
    setProposeOpen(false);
    setBanner(null);
    const error = await proposer.run(input);
    if (error) setBanner({ kind: 'error', lines: [error] });
  };
  const busy = running !== null || proposer.running;
  const textReadmes = view.readmes.filter((r) => r.hasText);

  const onExtract = () => {
    if (!latest) return;
    const existing = rows.some((r) => r.readmeId === latest.id);
    if (view.readmes.length === 1 && !existing) void runExtract(latest.id);
    else setExtractOpen(true);
  };

  const onOpenSource = (r: RequirementRow) => openSegment(sessionId, r.segmentId, r.readmeId);
  const onSaveNotes = async (id: string, notes: string) => {
    const res = await saveRequirementNotes({ requirementId: id, notes });
    if (res.ok) reload();
    return res;
  };

  const actions = completed ? null : (
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={onExtract} loading={running === 'extract'} disabled={!latest || busy}>
        <Sparkles aria-hidden className="size-4" />
        Extract requirements
      </Button>
      <Button variant="secondary" onClick={() => setAssessOpen(true)} loading={running === 'assess'} disabled={proposed === 0 || busy}>
        <ScanSearch aria-hidden className="size-4" />
        Assess coverage
      </Button>
      <Button
        variant="secondary"
        onClick={() => setProposeOpen(true)}
        loading={proposer.running}
        disabled={textReadmes.length === 0 || view.scriptOptions.length === 0 || busy}
        title={textReadmes.length === 0 ? 'Add a README with text first' : view.scriptOptions.length === 0 ? 'Add a script first' : undefined}
      >
        <FileDiff aria-hidden className="size-4" />
        Propose adaptation
      </Button>
    </div>
  );

  return (
    <section aria-label="Requirements matrix" className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-body font-semibold text-text">README requirements</h2>
          <p className="max-w-2xl text-small text-muted">
            Coverage is Claude&apos;s reading of a script, not proof the machine is hardened. A requirement is Verified only with a linked evidence report.
          </p>
        </div>
        {actions}
      </header>

      {completed ? <p className="text-small text-muted">This session is completed; its requirements are read-only.</p> : null}
      {running || proposer.running ? (
        <p role="status" className="text-small text-muted">
          {running === 'extract'
            ? 'Claude is reading the README…'
            : running === 'assess'
              ? 'Claude is comparing the script with the requirements…'
              : 'Claude is adapting the script to the README. This can take a minute…'}
        </p>
      ) : null}
      {banner ? (
        <div
          role={banner.kind === 'error' ? 'alert' : 'status'}
          className={cn('flex items-start justify-between gap-2 rounded-sm border bg-surface p-2 text-small', banner.kind === 'error' ? 'border-danger text-text' : 'border-border text-text')}
        >
          <div className="flex flex-col gap-1">
            {banner.lines.map((l) => (
              <p key={l}>{l}</p>
            ))}
          </div>
          <Button variant="ghost" className="h-control-sm px-2" aria-label="Dismiss message" onClick={() => setBanner(null)}>
            <X aria-hidden className="size-4" />
          </Button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No requirements yet — extract them from the README"
          description={
            !latest
              ? 'Add the README first. Claude reads it and lists each requirement with a link to the passage it came from.'
              : 'Claude reads the README and lists each requirement with a link to the passage it came from.'
          }
          actions={
            completed || !latest ? null : (
              <Button onClick={onExtract} loading={running === 'extract'} disabled={running !== null}>
                Extract requirements
              </Button>
            )
          }
        />
      ) : (
        <RequirementsMatrix rows={rows} readOnly={completed} onOpenSource={onOpenSource} onSaveNotes={onSaveNotes} onMarkReviewed={(id) => markRequirementReviewed({ requirementId: id })} />
      )}

      <ExtractDialog open={extractOpen} onOpenChange={setExtractOpen} view={view} onConfirm={runExtract} />
      <AssessDialog open={assessOpen} onOpenChange={setAssessOpen} view={view} onConfirm={runAssess} />
      <ProposeDialog open={proposeOpen} onOpenChange={setProposeOpen} view={view} onConfirm={runPropose} />
    </section>
  );
}

function ExtractDialog({ open, onOpenChange, view, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; view: RequirementsView; onConfirm: (readmeId: string) => void }) {
  const id = useId();
  const [choice, setChoice] = useState<string | null>(null);
  const readmeId = choice && view.readmes.some((r) => r.id === choice) ? choice : (view.readmes[0]?.id ?? '');
  const chosen = view.readmes.find((r) => r.id === readmeId);
  const existing = view.requirements.filter((r) => r.readmeId === readmeId).length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Extract requirements</DialogTitle>
          <DialogDescription>Claude reads only the README you choose and lists its requirements, each linked to its passage.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {view.readmes.length > 1 ? (
            <div className="flex flex-col gap-1 text-small text-muted">
              <label htmlFor={`${id}-readme`}>README</label>
              <select id={`${id}-readme`} className={cn(fieldClass, 'h-control')} value={readmeId} onChange={(e) => setChoice(e.target.value)}>
                {view.readmes.map((r, i) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                    {i === 0 ? ' · latest' : ''}
                    {r.hasText ? '' : ' · no text'}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {existing > 0 ? (
            <p className="text-small text-text">
              This README already has {n(existing, 'requirement', 'requirements')}. Re-extracting replaces this README&apos;s proposed requirements that have no notes; reported, verified and noted requirements are kept.
            </p>
          ) : null}
          {chosen && !chosen.hasText ? <p className="text-small text-warning">This README has no extractable text.</p> : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!readmeId} onClick={() => onConfirm(readmeId)}>
            Extract requirements
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssessDialog({ open, onOpenChange, view, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; view: RequirementsView; onConfirm: (versionId: string) => void }) {
  const id = useId();
  const [choice, setChoice] = useState('');
  const options = view.scriptOptions;
  const versionId = options.some((o) => o.id === choice) ? choice : '';
  const session = options.filter((o) => o.scope === 'session');
  const library = options.filter((o) => o.scope === 'library');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assess coverage</DialogTitle>
          <DialogDescription>
            Claude compares the README with one script version and marks each proposed requirement covered, missing or manual, and flags potentially disruptive ones for review. This is not proof the machine is hardened.
          </DialogDescription>
        </DialogHeader>
        {options.length === 0 ? (
          <p className="text-small text-muted">No scripts to assess against. Create a session script or add a script to your library.</p>
        ) : (
          <div className="flex flex-col gap-1 text-small text-muted">
            <label htmlFor={`${id}-script`}>Script version</label>
            <select id={`${id}-script`} className={cn(fieldClass, 'h-control')} value={versionId} onChange={(e) => setChoice(e.target.value)}>
              <option value="" disabled>
                Choose a script version
              </option>
              {session.length ? (
                <optgroup label="Session scripts">
                  {session.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {library.length ? (
                <optgroup label="Library scripts">
                  {library.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!versionId} onClick={() => onConfirm(versionId)}>
            Assess coverage
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The script version most requirements were last assessed against (the default to adapt). */
function assessedVersion(view: RequirementsView): string {
  const counts = new Map<string, number>();
  for (const r of view.requirements) if (r.scriptVersionId) counts.set(r.scriptVersionId, (counts.get(r.scriptVersionId) ?? 0) + 1);
  let best = '';
  for (const [id, n] of counts) if (view.scriptOptions.some((o) => o.id === id) && n > (counts.get(best) ?? 0)) best = id;
  return best;
}

function ProposeDialog({
  open,
  onOpenChange,
  view,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  view: RequirementsView;
  onConfirm: (input: { readmeId: string; scriptVersionId: string }) => void;
}) {
  const id = useId();
  const readmes = view.readmes.filter((r) => r.hasText);
  const [readmeChoice, setReadmeChoice] = useState('');
  const [scriptChoice, setScriptChoice] = useState<string | null>(null);
  const readmeId = readmes.some((r) => r.id === readmeChoice) ? readmeChoice : (readmes[0]?.id ?? '');
  const options = view.scriptOptions;
  const versionId = scriptChoice !== null && options.some((o) => o.id === scriptChoice) ? scriptChoice : assessedVersion(view);
  const session = options.filter((o) => o.scope === 'session');
  const library = options.filter((o) => o.scope === 'library');
  const chosen = options.find((o) => o.id === versionId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Propose adaptation</DialogTitle>
          <DialogDescription>
            Claude rewrites the chosen script for the README and lists every high-impact change. You review the diff and acknowledge each flagged line before anything is saved.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {readmes.length > 1 ? (
            <div className="flex flex-col gap-1 text-small text-muted">
              <label htmlFor={`${id}-readme`}>README</label>
              <select id={`${id}-readme`} className={cn(fieldClass, 'h-control')} value={readmeId} onChange={(e) => setReadmeChoice(e.target.value)}>
                {readmes.map((r, i) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                    {i === 0 ? ' · latest' : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="flex flex-col gap-1 text-small text-muted">
            <label htmlFor={`${id}-script`}>Script version</label>
            <select id={`${id}-script`} className={cn(fieldClass, 'h-control')} value={versionId} onChange={(e) => setScriptChoice(e.target.value)}>
              <option value="" disabled>
                Choose a script version
              </option>
              {session.length ? (
                <optgroup label="Session scripts">
                  {session.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {library.length ? (
                <optgroup label="Library scripts">
                  {library.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </div>
          {chosen?.scope === 'library' ? (
            <p className="text-small text-muted">This is a library script. Accepting saves a session copy; the library script itself never changes.</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!versionId || !readmeId} onClick={() => onConfirm({ readmeId, scriptVersionId: versionId })}>
            Propose adaptation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
