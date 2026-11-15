import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/features/sessions/actions', () => ({ createSessionAction: vi.fn() }));
const { CreateSessionDialog } = await import('@/features/sessions/CreateSessionDialog');

async function osFieldText(props: { defaultOs?: 'windows' | 'windows_server' | 'linux' | null }) {
  render(<CreateSessionDialog {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'New session' }));
  return screen.getByRole('combobox').textContent;
}

describe('New session dialog default OS', () => {
  it('starts on the saved default operating system', async () => {
    expect(await osFieldText({ defaultOs: 'linux' })).toBe('Linux');
  });
  it('falls back to Windows without a default', async () => {
    expect(await osFieldText({ defaultOs: null })).toBe('Windows');
  });
});
