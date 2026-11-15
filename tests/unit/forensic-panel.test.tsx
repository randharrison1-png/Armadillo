import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

type AddResult = { ok: true } | { ok: false; error: string };
const pendingAdds: Array<(r: AddResult) => void> = [];

vi.mock('@/features/sessions/completeActions', () => ({
  loadForensic: vi.fn(async () => ({ completed: false, questions: [] })),
  addForensicQuestionAction: vi.fn(() => new Promise<AddResult>((resolve) => pendingAdds.push(resolve))),
  answerForensicQuestionAction: vi.fn(async () => ({ ok: true })),
  reopenForensicQuestionAction: vi.fn(async () => ({ ok: true })),
}));

const { ForensicPanel } = await import('@/features/sessions/ForensicPanel');

describe('ForensicPanel add question', () => {
  it('keeps text typed while an earlier add was in flight', async () => {
    const user = userEvent.setup();
    render(createElement(ForensicPanel, { sessionId: 's1' }));
    const box = await screen.findByLabelText('New question');
    await user.type(box, 'First question');
    await user.click(screen.getByRole('button', { name: 'Add question' }));
    await waitFor(() => expect(pendingAdds).toHaveLength(1));
    // The user starts the next question before the first add resolves.
    await user.clear(box);
    await user.type(box, 'Second question');
    await act(async () => pendingAdds.shift()!({ ok: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add question' })).not.toHaveAttribute('aria-busy', 'true'));
    expect(screen.getByLabelText('New question')).toHaveValue('Second question');
  });

  it('clears the box when the text is unchanged since the add was sent', async () => {
    const user = userEvent.setup();
    render(createElement(ForensicPanel, { sessionId: 's2' }));
    const box = await screen.findByLabelText('New question');
    await user.type(box, 'Only question');
    await user.click(screen.getByRole('button', { name: 'Add question' }));
    await waitFor(() => expect(pendingAdds).toHaveLength(1));
    await act(async () => pendingAdds.shift()!({ ok: true }));
    await waitFor(() => expect(screen.getByLabelText('New question')).toHaveValue(''));
  });
});
