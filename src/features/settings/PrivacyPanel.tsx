'use client';

import { useId, useState, useTransition } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { deleteAccountAction } from './actions';
import { DELETE_PHRASE, EXPORT_MAX_BYTES } from './schema';

/** Plain-words privacy: what Claude receives, export my data, delete my account. */
export function PrivacyPanel() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h3 className="text-small font-semibold text-text">What Claude receives</h3>
        <ul className="flex list-disc flex-col gap-2 pl-4 text-small text-muted">
          <li>Every chat turn sends Claude the session title and operating system, the conversation so far, and your message.</li>
          <li>On top of that, it receives only the items you select in the session: scripts, the README, reports and evidence notes. The contents of evidence files are never sent.</li>
          <li>
            The buttons that ask Claude to work on something send what that work needs, without the picker: Extract requirements sends the README; Propose adaptation sends the README, the script and its requirements; Remediation sends the report&apos;s findings, the script and the requirements; mapping findings sends the findings and requirements.
          </li>
          <li>Nothing is sent automatically. Claude is called only when you send a message or press one of those buttons, and nothing from your library goes anywhere in the background.</li>
          <li>What is sent goes to Anthropic, using your own Claude API key if you saved one, or the workspace key set up on the server otherwise.</li>
          <li>Text from uploaded READMEs, reports and pasted content is treated as untrusted data, not as instructions.</li>
          <li>Your Claude API key is encrypted on the server. It never reaches your browser, and Armadillo shows only its last four characters.</li>
          <li>Pastes are public. Anything you publish to the pastebin can be read by anyone with the link (or by everyone, if it is listed), until you delete it.</li>
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-small font-semibold text-text">Export my data</h3>
        <p className="text-small text-muted">
          Download a zip with your sessions, scripts and versions, READMEs, conversations, reports, requirements, evidence, activity and pastes as JSON, plus your uploaded files. It never includes your Claude API key (only its last four characters). Exports are limited to {EXPORT_MAX_BYTES / 1024 / 1024} MB of data and files in total. The download link works for 10 minutes.
        </p>
        <ExportData />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-small font-semibold text-text">Delete account</h3>
        <p className="text-small text-muted">
          Permanently deletes your account, your sessions, scripts, uploaded files and history, and your pastes, including pastes that are public right now. There is no option to keep pastes, and this cannot be undone.
        </p>
        <DeleteAccount />
      </div>
    </div>
  );
}

function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputId = useId();
  const ready = typed.trim().toLowerCase() === DELETE_PHRASE;

  const confirm = () => {
    setError(null);
    startTransition(async () => {
      const r = await deleteAccountAction(typed);
      // Only failures return; success redirects to the sign-in page.
      if (r) setError(r.error);
    });
  };

  return (
    <>
      <div>
        <Button variant="danger" onClick={() => setOpen(true)}>
          <Trash2 aria-hidden className="size-4" />
          Delete account
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (pending) return;
          setOpen(o);
          if (!o) {
            setTyped('');
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete account</DialogTitle>
            <DialogDescription>
              This permanently deletes your account, your private files and rows, and all of your pastes. Your pastes are deleted too, even public ones, and their links stop working. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <label htmlFor={inputId} className="text-small font-medium text-text">
              Confirmation
            </label>
            <Input
              id={inputId}
              autoComplete="off"
              spellCheck={false}
              placeholder={DELETE_PHRASE}
              value={typed}
              disabled={pending}
              aria-describedby={`${inputId}-help`}
              onChange={(e) => setTyped(e.target.value)}
            />
            <p id={`${inputId}-help`} className="text-small text-muted">
              Type <span className="font-mono text-text">{DELETE_PHRASE}</span> to confirm.
            </p>
            {error ? (
              <p role="alert" className="text-small text-danger">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={!ready} loading={pending} onClick={confirm}>
              Delete my account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Builds the export on the server, then follows the short-lived signed URL it returns. */
function ExportData() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account/export', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        setError(body.error ?? 'The export failed. Try again.');
        return;
      }
      window.location.assign(body.url);
    } catch {
      setError('Could not reach the server to build the export. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button variant="secondary" loading={busy} onClick={run}>
          {busy ? null : <Download aria-hidden className="size-4" />}
          Export my data
        </Button>
      </div>
      {busy ? (
        <p role="status" className="text-small text-muted">
          Preparing your export…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
