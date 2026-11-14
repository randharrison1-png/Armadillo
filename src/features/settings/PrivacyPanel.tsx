'use client';

import { useId, useState, useTransition } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { deleteAccountAction } from './actions';
import { DELETE_PHRASE, EXPORT_MAX_FILE_BYTES } from './schema';

/** Plain-words privacy: what Claude receives, export my data, delete my account. */
export function PrivacyPanel() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h3 className="text-small font-semibold text-text">What Claude receives</h3>
        <ul className="flex list-disc flex-col gap-2 pl-4 text-small text-muted">
          <li>Claude receives only the items you select in a session: scripts, the README, reports and requirements. Selecting an item is what sends it.</li>
          <li>Nothing from your library is sent automatically, and nothing is sent in the background.</li>
          <li>What you select goes to Anthropic, using your own Claude API key if you saved one, or the workspace key set up on the server otherwise.</li>
          <li>Text from uploaded READMEs, reports and pasted content is treated as untrusted data, not as instructions.</li>
          <li>Your Claude API key is encrypted on the server. It never reaches your browser, and Armadillo shows only its last four characters.</li>
          <li>Pastes are public. Anything you publish to the pastebin can be read by anyone with the link (or by everyone, if it is listed), until you delete it.</li>
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-small font-semibold text-text">Export my data</h3>
        <p className="text-small text-muted">
          Download a zip with your sessions, scripts and versions, READMEs, conversations, reports, requirements, evidence, activity and pastes as JSON, plus your uploaded files. It never includes your Claude API key (only its last four characters). Exports hold up to {EXPORT_MAX_FILE_BYTES / 1024 / 1024} MB of uploaded files.
        </p>
        <div>
          <Button asChild variant="secondary">
            <a href="/api/account/export" download>
              <Download aria-hidden className="size-4" />
              Export my data
            </a>
          </Button>
        </div>
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
