import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

let path = '/app';
let search = '';
vi.mock('next/navigation', () => ({ usePathname: () => path, useSearchParams: () => new URLSearchParams(search) }));
vi.mock('@/server/auth/actions', () => ({ signOut: async () => {} }));

import { Sidebar } from '@/components/shell/Sidebar';

const current = () => screen.getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page').map((l) => l.textContent);

describe('Sidebar active state', () => {
  it('Sessions is current on /app/sessions/<id>, even for an id not in the recent list', () => {
    path = '/app/sessions/zzz';
    render(<Sidebar userEmail="a@b.test" sessions={[{ id: 'one', title: 'One' }]} />);
    expect(current()).toEqual(['Sessions']);
  });
  it('Sessions is current on /app/sessions', () => {
    path = '/app/sessions';
    render(<Sidebar userEmail="a@b.test" />);
    expect(current()).toEqual(['Sessions']);
  });
  it('Dashboard only on /app', () => {
    path = '/app';
    render(<Sidebar userEmail="a@b.test" />);
    expect(current()).toEqual(['Dashboard']);
  });
});

describe('Sidebar library children', () => {
  const highlighted = () =>
    screen
      .getAllByRole('link')
      .filter((l) => l.classList.contains('bg-surface-raised'))
      .map((l) => l.textContent);

  it('shows counts per category and links to ?category=', () => {
    path = '/app/library';
    search = '';
    render(<Sidebar userEmail="a@b.test" libraryCounts={{ linux: 4, windows: 1 }} />);
    expect(screen.getByRole('link', { name: 'Linux (4)' })).toHaveAttribute('href', '/app/library?category=linux');
    expect(screen.getByRole('link', { name: 'Windows (1)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'LEADS/Audit (0)' })).toBeInTheDocument();
    expect(highlighted()).toEqual([]);
  });
  it('highlights the child matching ?category= on the library page', () => {
    path = '/app/library';
    search = 'category=linux';
    render(<Sidebar userEmail="a@b.test" libraryCounts={{ linux: 4 }} />);
    expect(highlighted()).toEqual(['Linux (4)']);
    expect(current()).toEqual(['Script Library']);
  });
  it('highlights nothing for a category param on another page', () => {
    path = '/app';
    search = 'category=linux';
    render(<Sidebar userEmail="a@b.test" libraryCounts={{ linux: 4 }} />);
    expect(highlighted()).toEqual([]);
  });
});
