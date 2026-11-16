import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceTabs } from '@/components/shell/WorkspaceTabs';
import { getWorkspaceStore, resetWorkspaceStores } from '@/features/workspace/store';

beforeEach(() => {
  localStorage.clear();
  resetWorkspaceStores();
});

describe('WorkspaceTabs', () => {
  it('renders default tabs; claude has no close button', () => {
    render(<WorkspaceTabs sessionId="s1" />);
    expect(screen.getByRole('tab', { name: 'Claude', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Flowchart' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close Claude' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close Flowchart' })).toBeInTheDocument();
  });

  it('opening a tab activates it, keeps claude, and closing returns to a neighbor', async () => {
    const user = userEvent.setup();
    render(<WorkspaceTabs sessionId="s1" />);
    act(() => getWorkspaceStore('s1').getState().openTab({ key: 'script:1', kind: 'script', title: 'harden.sh' }));
    expect(screen.getByRole('tab', { name: 'harden.sh', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Claude' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close harden.sh' }));
    expect(screen.queryByRole('tab', { name: 'harden.sh' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Flowchart', selected: true })).toBeInTheDocument();
  });

  it('arrow keys move between tabs', async () => {
    const user = userEvent.setup();
    render(<WorkspaceTabs sessionId="s1" />);
    screen.getByRole('tab', { name: 'Claude' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Flowchart', selected: true })).toHaveFocus();
  });
});
