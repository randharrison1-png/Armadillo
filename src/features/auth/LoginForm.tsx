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
}: {
  action: Action;
  withPassword: boolean;
  submitLabel: string;
  icon: React.ReactNode;
  passwordAutoComplete?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const invalid = Boolean(state.error) || undefined;
  return (
    // noValidate: validation happens on the server so the error state is consistent.
    <form action={formAction} noValidate className="flex flex-col gap-4">
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

export function LoginForm({ mode }: { mode: AuthMode }) {
  const [view, setView] = useState<'sign-in' | 'sign-up'>('sign-in');

  if (mode === 'test') {
    return (
      <AuthForm action={signInWithEmail} withPassword={false} submitLabel="Sign in" icon={<LogIn aria-hidden className="size-4" />} />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {view === 'sign-in' ? (
        <AuthForm
          key="sign-in"
          action={signInWithPassword}
          withPassword
          passwordAutoComplete="current-password"
          submitLabel="Sign in"
          icon={<LogIn aria-hidden className="size-4" />}
        />
      ) : (
        <AuthForm
          key="sign-up"
          action={signUpWithPassword}
          withPassword
          passwordAutoComplete="new-password"
          submitLabel="Create account"
          icon={<UserPlus aria-hidden className="size-4" />}
        />
      )}
      <Button variant="ghost" type="button" onClick={() => setView(view === 'sign-in' ? 'sign-up' : 'sign-in')}>
        {view === 'sign-in' ? 'Create an account' : 'I already have an account'}
      </Button>
    </div>
  );
}
