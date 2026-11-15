import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.fn();
vi.mock('geist/font/sans', () => ({ GeistSans: { variable: 'geist-sans' } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));

import AppError from '@/app/(app)/app/error';
import RootError from '@/app/error';
import GlobalError from '@/app/global-error';
import NotFound from '@/app/not-found';
import AppNotFound from '@/app/(app)/app/not-found';

const SECRET = 'connect ECONNREFUSED 10.0.0.5:5432 password=hunter2';
const boom = () => Object.assign(new Error(SECRET), { digest: 'dg-1234', stack: `Error: ${SECRET}\n    at secret.ts:1:1` });

beforeEach(() => refresh.mockClear());
afterEach(() => vi.restoreAllMocks());

describe.each([
  ['root error.tsx', RootError],
  ['app error.tsx', AppError],
])('%s', (_name, Boundary) => {
  it('shows generic copy and the digest, never the error message or stack', () => {
    const { container } = render(<Boundary error={boom()} reset={() => {}} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(alert).toHaveTextContent('dg-1234');
    expect(container.textContent).not.toContain('ECONNREFUSED');
    expect(container.textContent).not.toContain('hunter2');
    expect(container.textContent).not.toContain('secret.ts');
  });

  it('omits the reference line when there is no digest', () => {
    render(<Boundary error={new Error('x')} reset={() => {}} />);
    expect(screen.getByRole('alert')).not.toHaveTextContent(/reference/i);
  });

  it('"Try again" refetches the route from the server and resets the boundary', () => {
    const reset = vi.fn();
    render(<Boundary error={boom()} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('global-error.tsx', () => {
  it('renders its own document with generic copy, the digest and a reload button, without the message', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const { container } = render(<GlobalError error={boom()} reset={() => {}} />, { container: document.documentElement });
    expect(container.textContent).toContain('Something went wrong');
    expect(container.textContent).toContain('dg-1234');
    expect(container.textContent).not.toContain('hunter2');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('not-found pages', () => {
  it('root not-found explains and offers a way back', () => {
    render(<NotFound />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the workspace' })).toHaveAttribute('href', '/app');
  });

  it('app not-found offers the dashboard', () => {
    render(<AppNotFound />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute('href', '/app');
  });
});
