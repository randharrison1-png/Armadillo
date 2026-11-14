'use client';

import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatDate } from '@/features/sessions/dates';
import { recordPointsAction, submitFinalAction } from './completeActions';
import { forensicCountLabel, OVERRIDE_MAX, OVERRIDE_MIN, POINTS_MAX, validPoints } from './completeRules';

const fmt = (n: number | null) => (n === null ? 'Not recorded' : String(n));

/**
 * "Check final points" (spec 8.1 step 8): the user records the points the scoring page shows. The value
 * is self-reported, kept per audit cycle and shown as "Reported points"; it is not verification and
 * never changes a step or starts a cycle (the branch conditions are an open question), the user decides.
 */
export function PointsPanel({
  sessionId,
  currentCycle,
  points,
  readOnly,
  onChanged,
}: {
  sessionId: string;
  currentCycle: number;
  points: { points: number | null; target: number | null };
  readOnly: boolean;
  onChanged: () => void;
}) {
  const id = useId();
  const [score, setScore] = useState('');
  const [target, setTarget] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    const s = Number(score);
    const t = target.trim() === '' ? null : Number(target);
    if (score.trim() === '' || !validPoints(s) || (t !== null && !validPoints(t))) {
      return setError(`Enter points from 0 to ${POINTS_MAX} with at most 2 decimals`);
    }
    setPending(true);
    try {
      const r = await recordPointsAction({ sessionId, score: s, target: t });
      if (!r.ok) return setError(r.error);
      setScore('');
      setTarget('');
      toast.success('Points recorded');
      onChanged();
    } catch {
      setError('Could not record the points. Try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-label="Final points" className="flex flex-col gap-2">
      <h4 className="font-medium text-text">Final points</h4>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt>Reported points (cycle {currentCycle})</dt>
        <dd data-testid="reported-points" className="text-text">
          {fmt(points.points)}
        </dd>
        <dt>Target</dt>
        <dd data-testid="target-points" className="text-text">
          {fmt(points.target)}
        </dd>
      </dl>
      <p>Self-reported from the scoring page. It does not verify anything and does not change a step or start another cycle.</p>
      {readOnly ? null : (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-score`} className="font-medium text-text">
            Points
          </label>
          <Input id={`${id}-score`} inputMode="decimal" value={score} onChange={(e) => setScore(e.target.value)} aria-invalid={error ? true : undefined} />
          <label htmlFor={`${id}-target`} className="font-medium text-text">
            Target (optional)
          </label>
          <Input id={`${id}-target`} inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} aria-invalid={error ? true : undefined} />
          <div>
            <Button variant="secondary" onClick={() => void save()} loading={pending} disabled={score.trim() === ''}>
              Record points
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-danger">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * "Submit final" (spec 8.1 step 8, 13.1 step 11): marks the step Complete and Verified (it needs
 * verification evidence of this cycle) and freezes the session. Open forensic questions block it
 * unless the user gives a reason, which is recorded.
 */
export function SubmitPanel({
  sessionId,
  forensic,
  completedAt,
  onChanged,
}: {
  sessionId: string;
  forensic: { total: number; answered: number };
  completedAt: string | null;
  onChanged: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = forensic.total - forensic.answered;
  const blocked = open > 0 && reason.trim().length < OVERRIDE_MIN;

  if (completedAt) {
    return (
      <section aria-label="Final submission" className="flex flex-col gap-2">
        <h4 className="font-medium text-text">Final submission</h4>
        <p>Submitted {formatDate(completedAt)}. The session is completed and read-only; everything stays viewable.</p>
      </section>
    );
  }

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const r = await submitFinalAction({ sessionId, overrideForensics: open > 0 ? reason : undefined });
      if (!r.ok) return setError(r.error);
      setConfirming(false);
      toast.success('Session submitted');
      onChanged();
    } catch {
      setError('Could not submit the session. Try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-label="Final submission" className="flex flex-col gap-2">
      <h4 className="font-medium text-text">Final submission</h4>
      <p>
        Forensic questions: <span data-testid="submit-forensic-count" className="text-text">{forensicCountLabel(forensic.total, forensic.answered)}</span>
      </p>
      {open > 0 ? (
        <>
          <label htmlFor={`${id}-reason`} className="font-medium text-text">
            Reason to submit with open questions
          </label>
          <Textarea id={`${id}-reason`} rows={3} maxLength={OVERRIDE_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />
          <p>
            {open} {open === 1 ? 'question is' : 'questions are'} still open. Answer {open === 1 ? 'it' : 'them'}, or give a reason of at least {OVERRIDE_MIN} characters; the reason is recorded.
          </p>
        </>
      ) : null}
      <p>Submitting needs verification evidence attached to this step in the current cycle.</p>
      <div>
        <Button onClick={() => (setError(null), setConfirming(true))} disabled={blocked}>
          Submit final
        </Button>
      </div>
      {error && !confirming ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
      <Dialog open={confirming} onOpenChange={(o) => !o && !pending && setConfirming(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit this session?</DialogTitle>
            <DialogDescription>
              Submitting freezes this session. Everything stays viewable (README, versions, notes, reports, cycles and evidence), but nothing can be added or changed afterwards.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-small text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} loading={pending}>
              Submit and freeze session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
