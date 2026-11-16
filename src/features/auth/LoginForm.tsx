'use client';

import { useActionState, useId, useState } from 'react';
import { AlertTriangle, LogIn, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  signInWithEmail,
  signInWithPassword,
  signUpWithPassword,
  type AuthFormState,
} from '@/server/auth/actions';
import type { AuthMode } from '@/server/auth/types';

type Action = (prev: AuthFormState, formData: FormData) => Promise<AuthFormState>;

function Field({ label, ...props }: { label: string } & React.ComponentProps<typeof Input>) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-small font-medium text-text">
        {label}
      </label>
      <Input id={id} {...props} />
    </div>
  );
}

function FormStatus({ state }: { state: AuthFormState }) {
  if (state.error) {
    return (
      <p role="alert" className="flex items-center gap-2 text-small text-danger">
        <AlertTriangle aria-hidden className="size-4 shrink-0" />
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p role="status" className="text-small text-muted">
        {state.message}
      </p>
    );
  }
  return null;
}

function AuthForm({
  action,
  withPassword,
  submitLabel,
  icon,
  passwordAutoComplete,
  next,
}: {
  action: Action;
  withPassword: boolean;
  submitLabel: string;
  icon: React.ReactNode;
  passwordAutoComplete?: string;
  next?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const invalid = Boolean(state.error) || undefined;
  return (
    // noValidate: validation happens on the server so the error state is consistent.
    <form action={formAction} noValidate className="flex flex-col gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Field label="Email" name="email" type="email" autoComplete="email" required aria-invalid={invalid} />
      {withPassword ? (
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete={passwordAutoComplete}
          minLength={8}
          required
          aria-invalid={invalid}
        />
      ) : null}
      <FormStatus state={state} />
      <Button type="submit" loading={pending}>
        {pending ? null : icon}
        {submitLabel}
      </Button>
    </form>
  );
}

/**
 * `next`: where to go after signing in (already validated by the page with safeNext).
 * `signupsEnabled`: SIGNUPS_ENABLED on the server; when false there is no sign-up affordance (the
 * action refuses too).
 */
export function LoginForm({ mode, next, signupsEnabled = true }: { mode: AuthMode; next?: string; signupsEnabled?: boolean }) {
  const [view, setView] = useState<'sign-in' | 'sign-up'>('sign-in');

  if (mode === 'test') {
    return (
      <AuthForm action={signInWithEmail} withPassword={false} submitLabel="Sign in" icon={<LogIn aria-hidden className="size-4" />} next={next} />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {view === 'sign-in' || !signupsEnabled ? (
        <AuthForm
          key="sign-in"
          action={signInWithPassword}
          withPassword
          passwordAutoComplete="current-password"
          next={next}
          submitLabel="Sign in"
          icon={<LogIn aria-hidden className="size-4" />}
        />
      ) : (
        <AuthForm
          key="sign-up"
          action={signUpWithPassword}
          withPassword
          passwordAutoComplete="new-password"
          next={next}
          submitLabel="Create account"
          icon={<UserPlus aria-hidden className="size-4" />}
        />
      )}
      {signupsEnabled ? (
        <Button variant="ghost" type="button" onClick={() => setView(view === 'sign-in' ? 'sign-up' : 'sign-in')}>
          {view === 'sign-in' ? 'Create an account' : 'I already have an account'}
        </Button>
      ) : null}
    </div>
  );
}
