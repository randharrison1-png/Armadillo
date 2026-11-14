import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FlagChecklist } from '@/features/proposals/FlagChecklist';
import { reviewFlags, acceptLabel, proposalTab, parseProposalResourceId } from '@/features/proposals/review';
import { scanHighImpact, resolveClaudeFlags, mergeFlags } from '@/server/security/highImpact';

const content = ['Write-Host start', 'Disable-LocalUser -Name Guest', 'Stop-Service -Name Spooler', 'netsh advfirewall set allprofiles state on'].join('\r\n');
const stored = mergeFlags(
  scanHighImpact(content, 'powershell'),
  resolveClaudeFlags([{ category: 'other', line: 1, reason: 'Claude: announces the run' }], content).flags,
);

describe('review helpers', () => {
  it('reviewFlags marks flags found only in the edited text as "edit"', () => {
    const unchanged = reviewFlags(stored, content, 'powershell');
    expect(unchanged.map((f) => f.origin)).toEqual(['proposal', 'proposal', 'proposal', 'proposal']);
    const edited = reviewFlags(stored, `${content}\r\nRemove-LocalUser eve`, 'powershell');
    expect(edited.map((f) => [f.line, f.category, f.origin])).toEqual([
      [1, 'other', 'proposal'],
      [2, 'accounts', 'proposal'],
      [3, 'services', 'proposal'],
      [4, 'firewall', 'proposal'],
      [5, 'accounts', 'edit'],
    ]);
  });

  it('acceptLabel shows the acknowledgement count', () => {
    expect(acceptLabel(0, 0)).toBe('Accept');
    expect(acceptLabel(1, 4)).toBe('Accept (1 of 4 acknowledged)');
    expect(acceptLabel(4, 4)).toBe('Accept (4 of 4 acknowledged)');
  });

  it('proposal tabs use the diff kind and resourceId proposal:<id>', () => {
    const id = '0b6f7d4e-0a1b-4c2d-8e3f-123456789abc';
    expect(proposalTab(id, 'harden.ps1')).toEqual({ key: `diff:proposal:${id}`, kind: 'diff', title: 'harden.ps1 · proposal', resourceId: `proposal:${id}` });
    expect(parseProposalResourceId(`proposal:${id}`)).toBe(id);
    expect(parseProposalResourceId(`${id}:${id}..${id}`)).toBeNull();
    expect(parseProposalResourceId('proposal:nope')).toBeNull();
  });
});

describe('FlagChecklist', () => {
  const flags = reviewFlags(stored, `${content}\r\nRemove-LocalUser eve`, 'powershell');

  it('groups flags by category, with a line jump and an acknowledgement per flag', async () => {
    const onToggle = vi.fn();
    const onJump = vi.fn();
    render(createElement(FlagChecklist, { flags, acknowledged: [flags[1].id], onToggle, onJump }));

    const accounts = screen.getByRole('group', { name: /Accounts/ });
    expect(within(accounts).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(accounts).getByText('Disable-LocalUser -Name Guest')).toBeInTheDocument();
    expect(within(accounts).getByText('Found in your edits')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Services/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Firewall/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Other/ })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /Remote access/ })).toBeNull();
    expect(screen.getByText('Claude: announces the run')).toBeInTheDocument();

    expect(screen.getByRole('checkbox', { name: 'Acknowledge Accounts change on line 2' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Acknowledge Services change on line 3' })).not.toBeChecked();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Acknowledge Services change on line 3' }));
    expect(onToggle).toHaveBeenCalledWith(flags[2].id, true);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Acknowledge Accounts change on line 2' }));
    expect(onToggle).toHaveBeenCalledWith(flags[1].id, false);

    await userEvent.click(screen.getByRole('button', { name: 'Go to line 4' }));
    expect(onJump).toHaveBeenCalledWith(4);
  });

  it('read-only: checkboxes are disabled, jumps still work', async () => {
    const onJump = vi.fn();
    render(createElement(FlagChecklist, { flags, acknowledged: flags.map((f) => f.id), onToggle: vi.fn(), onJump, readOnly: true }));
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Go to line 2' }));
    expect(onJump).toHaveBeenCalledWith(2);
  });

  it('empty state when nothing is high-impact', () => {
    render(createElement(FlagChecklist, { flags: [], acknowledged: [], onToggle: vi.fn(), onJump: vi.fn() }));
    expect(screen.getByText('No high-impact changes found')).toBeInTheDocument();
  });
});
