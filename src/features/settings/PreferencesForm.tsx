'use client';

import { useId, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, PlugZap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { OsType } from '@/lib/types';
import {
  testConnectionAction,
  updateDefaultOsAction,
  updateDisplayNameAction,
  updateModelAction,
} from './actions';
import { DISPLAY_NAME_MAX, MODEL_OPTIONS, OS_LABEL, OS_VALUES, SERVER_DEFAULT_MODEL, type SettingsActionResult, type TestConnectionResult } from './schema';

type Message = { kind: 'ok' | 'error'; text: string } | null;

function Feedback({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'text-small text-danger' : 'text-small text-accent'}>
      {message.text}
    </p>
  );
}

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-small font-medium text-text">
        {label}
      </label>
      {children}
      {help ? <p className="text-small text-muted">{help}</p> : null}
    </div>
  );
}

/** Runs a save action and turns its result into an inline message. */
function useSave(okText: string) {
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const run = (action: () => Promise<SettingsActionResult>) => {
    setMessage(null);
    startTransition(async () => {
      const r = await action();
      setMessage(r.ok ? { kind: 'ok', text: okText } : { kind: 'error', text: r.error });
    });
  };
  return { message, pending, run };
}

/** Account: the display name. */
export function DisplayNameForm({ initial }: { initial: string | null }) {
  const [name, setName] = useState(initial ?? '');
  const { message, pending, run } = useSave('Display name saved.');
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(() => updateDisplayNameAction(name));
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Field id={id} label="Display name" help="Shown in your workspace. Leave it empty to use your email address.">
        <div className="flex flex-wrap gap-2">
          <Input id={id} name="display-name" autoComplete="name" maxLength={DISPLAY_NAME_MAX} value={name} disabled={pending} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1" />
          <Button type="submit" loading={pending}>
            Save name
          </Button>
        </div>
      </Field>
      <Feedback message={message} />
    </form>
  );
}

/** Defaults: the operating system new sessions start with. */
export function DefaultOsForm({ initial }: { initial: OsType | null }) {
  const [value, setValue] = useState<string>(initial ?? 'none');
  const { message, pending, run } = useSave('Default operating system saved.');
  const id = useId();
  const change = (next: string) => {
    setValue(next);
    run(() => updateDefaultOsAction(next));
  };
  return (
    <div className="flex flex-col gap-2">
      <Field id={id} label="Default operating system" help="The system new sessions start with. You can still choose another one for each session.">
        <Select value={value} onValueChange={change} disabled={pending}>
          <SelectTrigger id={id} className="sm:max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No default</SelectItem>
            {OS_VALUES.map((os) => (
              <SelectItem key={os} value={os}>
                {OS_LABEL[os]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Feedback message={message} />
    </div>
  );
}

const CONNECTION_TEXT = (r: TestConnectionResult): { kind: 'ok' | 'error'; text: string } => {
  switch (r.status) {
    case 'ok':
      return { kind: 'ok', text: `Connected. Claude answered with ${r.model} using ${r.source === 'user' ? 'your key' : 'the workspace key'}.` };
    case 'invalid_key':
      return { kind: 'error', text: 'Claude rejected the API key. Check it and save it again.' };
    case 'network':
      return { kind: 'error', text: 'Could not reach Claude. Check the connection and try again.' };
    case 'no_key':
      return { kind: 'error', text: 'No key is available. Save your Claude API key first.' };
    case 'error':
      return { kind: 'error', text: r.message };
  }
};

/** Claude: which model to use, and a one-token connection test. */
export function ClaudeModelForm({ initial }: { initial: string | null }) {
  const [value, setValue] = useState<string>(initial ?? SERVER_DEFAULT_MODEL);
  const { message, pending, run } = useSave('Model saved.');
  const [result, setResult] = useState<ReturnType<typeof CONNECTION_TEXT> | null>(null);
  const [testing, startTesting] = useTransition();
  const id = useId();
  const change = (next: string) => {
    setValue(next);
    setResult(null);
    run(() => updateModelAction(next));
  };
  const test = () => {
    setResult(null);
    startTesting(async () => setResult(CONNECTION_TEXT(await testConnectionAction())));
  };
  return (
    <div className="flex flex-col gap-4">
      <Field id={id} label="Claude model" help="“Server default” uses the model the workspace is configured with.">
        <Select value={value} onValueChange={change} disabled={pending}>
          <SelectTrigger id={id} className="sm:max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODEL_OPTIONS.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Feedback message={message} />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" loading={testing} onClick={test}>
            {testing ? null : <PlugZap aria-hidden className="size-4" />}
            Test connection
          </Button>
          <span className="text-small text-muted">Sends one tiny request with the key and model above. Your key is never shown.</span>
        </div>
        {result ? (
          <p
            data-testid="connection-result"
            role={result.kind === 'error' ? 'alert' : 'status'}
            className={result.kind === 'error' ? 'flex items-center gap-2 text-small text-danger' : 'flex items-center gap-2 text-small text-accent'}
          >
            {result.kind === 'error' ? <CircleAlert aria-hidden className="size-4 shrink-0" /> : <CircleCheck aria-hidden className="size-4 shrink-0" />}
            {result.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
