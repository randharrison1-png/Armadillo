'use client';

import { useId, useState, useTransition } from 'react';
import { AlertTriangle, Flag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { reportPasteAction } from './actions';
import { retryMessage } from './format';

const REASON_MAX = 2000;

/** "Report" link on a public paste: a small form that works signed out. */
export function ReportAbuse({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <Flag aria-hidden className="size-4" />
        Report
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <ReportForm slug={slug} onClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReportForm({ slug, onClose }: { slug: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();
  const id = useId();

  if (sent) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Report sent</DialogTitle>
        </DialogHeader>
        <p role="status" className="text-small text-text">
          Thanks — we&apos;ll review this paste.
        </p>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Report this paste</DialogTitle>
        <DialogDescription>Tell us what is wrong with it, for example malware, leaked credentials or abuse. You do not need an account.</DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!reason.trim()) return setError('Tell us what is wrong with this paste.');
          setError(null);
          start(async () => {
            try {
              const r = await reportPasteAction({ slug, reason });
              if (r.ok) setSent(true);
              else setError(r.retryAfter ? `${r.error} ${retryMessage(r.retryAfter)}` : r.error);
            } catch {
              setError('Could not send the report. Try again.');
            }
          });
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={id} className="text-small font-medium text-text">
            Reason
          </label>
          <Textarea id={id} value={reason} rows={5} maxLength={REASON_MAX} aria-invalid={Boolean(error)} onChange={(e) => setReason(e.target.value)} />
          <p className="text-small text-muted">
            {reason.length} / {REASON_MAX}
          </p>
        </div>
        {error ? (
          <p role="alert" className="flex items-center gap-2 text-small text-danger">
            <AlertTriangle aria-hidden className="size-4 shrink-0" />
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Send report
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
