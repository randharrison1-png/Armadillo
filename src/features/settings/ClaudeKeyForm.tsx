'use client';

import { useId, useState, useTransition, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { removeClaudeKeyAction, saveClaudeKeyAction } from './actions';

export type ClaudeKeyFormStatus = { hasUserKey: boolean; last4: string | null; serverKeyAvailable: boolean };

/**
 * Save, replace or remove the user's own Claude API key. The key is sent to the server once, on
 * save; afterwards only its last four characters (••••abcd) are ever shown — the server never
 * returns the key or its ciphertext.
 */
export function ClaudeKeyForm({ initial }: { initial: ClaudeKeyFormStatus }) {
  const [status, setStatus] = useState(initial);
  const [editing, setEditing] = useState(!initial.hasUserKey);
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const inputId = useId();
  const helpId = useId();

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) {
      setMessage({ kind: 'error', text: 'Enter your Claude API key.' });
      return;
    }
    setBusy('save');
    startTransition(async () => {
      const r = await saveClaudeKeyAction(value);
      setBusy(null);
      if (!r.ok) return setMessage({ kind: 'error', text: r.error });
      setValue('');
      setStatus((s) => ({ ...s, hasUserKey: true, last4: r.last4 }));
      setEditing(false);
      setMessage({ kind: 'ok', text: 'Key saved.' });
    });
  };

  const remove = () => {
    setBusy('remove');
    startTransition(async () => {
      const r = await removeClaudeKeyAction();
      setBusy(null);
      if (!r.ok) return setMessage({ kind: 'error', text: r.error });
      setStatus((s) => ({ ...s, hasUserKey: false, last4: null }));
      setEditing(true);
      setMessage({ kind: 'ok', text: 'Key removed.' });
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <p id={helpId} className="text-small text-muted">
        Your key is encrypted and kept on the server. It is never shown again or sent to your browser; Armadillo shows only its last four characters.
      </p>

      {status.hasUserKey && !editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <KeyRound aria-hidden className="size-4 text-accent" />
          <span className="text-small text-text">Your key</span>
          <span data-testid="claude-key-masked" className="font-mono text-small text-text">
            ••••{status.last4}
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setMessage(null);
                setEditing(true);
              }}
            >
              Replace
            </Button>
            <Button variant="danger" loading={busy === 'remove'} disabled={pending} onClick={remove}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-2">
          <label htmlFor={inputId} className="text-small font-medium text-text">
            Claude API key
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={inputId}
              type="password"
              name="claude-api-key"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-…"
              aria-describedby={helpId}
              aria-invalid={message?.kind === 'error' || undefined}
              maxLength={300}
              value={value}
              disabled={pending}
              onChange={(e) => setValue(e.target.value)}
              className="min-w-0 flex-1 font-mono"
            />
            <Button type="submit" loading={busy === 'save'} disabled={pending}>
              {status.hasUserKey ? 'Save new key' : 'Save key'}
            </Button>
            {status.hasUserKey ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setValue('');
                  setMessage(null);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      )}

      {!status.hasUserKey ? (
        <p className="text-small text-muted">
          {status.serverKeyAvailable
            ? 'Without your own key, Claude uses the workspace key configured on the server.'
            : 'No key is configured yet. Claude features need a key.'}
        </p>
      ) : null}

      {message ? (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'text-small text-danger' : 'text-small text-accent'}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
