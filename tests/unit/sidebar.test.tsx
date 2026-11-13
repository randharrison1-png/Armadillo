import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

let path = '/app';
vi.mock('next/navigation', () => ({ usePathname: () => path }));
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
