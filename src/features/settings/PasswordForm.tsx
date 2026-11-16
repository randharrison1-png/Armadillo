'use client';

import { useId, useState, useTransition, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { changePasswordAction } from './actions';
import { PASSWORD_MIN } from './schema';

/** Account: change the password (re-authenticates with the current one). Disabled under the test provider. */
export function PasswordForm({ managedByTestProvider }: { managedByTestProvider: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const currentId = useId();
  const nextId = useId();

  if (managedByTestProvider) {
    return <p className="text-small text-muted">Password is managed by the test sign-in provider.</p>;
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const r = await changePasswordAction(current, next);
      if (r.ok) {
        setCurrent('');
        setNext('');
        setMessage({ kind: 'ok', text: 'Password changed.' });
      } else setMessage({ kind: 'error', text: r.error });
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor={currentId} className="text-small font-medium text-text">
          Current password
        </label>
        <Input id={currentId} type="password" name="current-password" autoComplete="current-password" value={current} disabled={pending} onChange={(e) => setCurrent(e.target.value)} className="sm:max-w-xs" />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor={nextId} className="text-small font-medium text-text">
          New password
        </label>
        <Input id={nextId} type="password" name="new-password" autoComplete="new-password" minLength={PASSWORD_MIN} value={next} disabled={pending} onChange={(e) => setNext(e.target.value)} className="sm:max-w-xs" />
        <p className="text-small text-muted">At least {PASSWORD_MIN} characters.</p>
      </div>
      <div>
        <Button type="submit" loading={pending} disabled={!current || !next}>
          Change password
        </Button>
      </div>
      {message ? (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'text-small text-danger' : 'text-small text-accent'}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
