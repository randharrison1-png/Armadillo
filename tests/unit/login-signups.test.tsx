import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/server/auth/actions', () => ({ signInWithEmail: vi.fn(), signInWithPassword: vi.fn(), signUpWithPassword: vi.fn() }));
const { LoginForm } = await import('@/features/auth/LoginForm');

describe('LoginForm sign-up affordance', () => {
  it('offers "Create an account" when sign-ups are enabled', () => {
    render(createElement(LoginForm, { mode: 'supabase', signupsEnabled: true }));
    expect(screen.getByRole('button', { name: 'Create an account' })).toBeInTheDocument();
  });

  it('hides it when sign-ups are disabled', () => {
    render(createElement(LoginForm, { mode: 'supabase', signupsEnabled: false }));
    expect(screen.queryByRole('button', { name: 'Create an account' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});
