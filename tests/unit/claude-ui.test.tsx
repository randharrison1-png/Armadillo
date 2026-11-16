import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from '@/features/claude/Composer';
import { MessageList } from '@/features/claude/MessageList';
import type { ChatMessage } from '@/features/claude/types';

vi.mock('@/features/claude/actions', () => ({}));

const base: Pick<ChatMessage, 'refs' | 'requestId' | 'createdAt'> = { refs: [], requestId: 'r1', createdAt: '2026-11-13T00:00:00.000Z' };
const msg = (m: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'content' | 'status'>): ChatMessage => ({ ...base, ...m });

describe('MessageList', () => {
  it('renders Claude output as Markdown without raw HTML; links open safely; user text stays plain', () => {
    const { container } = render(
      <MessageList
        busy={false}
        readOnly={false}
        labels={new Map([['readme:a1', 'README · pasted']])}
        onRetry={() => {}}
        messages={[
          msg({ id: 'u', role: 'user', content: '**not bold** <b>tag</b>', status: 'complete', refs: [{ type: 'readme', id: 'a1' }] }),
          msg({
            id: 'a',
            role: 'assistant',
            status: 'complete',
            content:
              'Run **this**:\n\n```powershell\nSet-Service -Name RemoteRegistry -StartupType Disabled\n```\n\n<img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script>\n\n[docs](https://example.com/docs) [bad](javascript:alert(1)) ![track](https://evil.example/t.png)',
          }),
        ]}
      />,
    );
    // User text: literal.
    expect(screen.getByText('**not bold** <b>tag</b>')).toBeInTheDocument();
    expect(screen.getByText('README · pasted')).toBeInTheDocument();
    // Markdown rendered.
    expect(container.querySelector('strong')?.textContent).toBe('this');
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('Set-Service -Name RemoteRegistry');
    expect(pre?.className).toContain('font-mono');
    // No raw HTML elements, no images; HTML shows as text.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>window.__pwned=2</script>');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    // Links.
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const bad = screen.queryByRole('link', { name: 'bad' });
    expect(bad?.getAttribute('href') ?? '').not.toMatch(/javascript:/i);
  });

  it('a failed reply keeps its partial text and offers Retry with the prompt’s request id', async () => {
    const onRetry = vi.fn();
    render(
      <MessageList
        busy={false}
        readOnly={false}
        labels={new Map()}
        onRetry={onRetry}
        messages={[
          msg({ id: 'u', role: 'user', content: 'Adapt it', status: 'complete', requestId: 'req-9' }),
          msg({ id: 'a', role: 'assistant', content: 'Partial answer', status: 'error', requestId: 'req-9', errorCode: 'overloaded', errorMessage: 'Claude is overloaded right now. Retry in a moment.' }),
        ]}
      />,
    );
    expect(screen.getByText('Partial answer')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Claude is overloaded right now.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledWith('req-9');
  });

  it('a missing key links to Settings; Retry is disabled while busy and hidden when read-only', () => {
    const messages = [
      msg({ id: 'u', role: 'user', content: 'hi', status: 'complete' }),
      msg({ id: 'a', role: 'assistant', content: '', status: 'error', errorCode: 'no_key' }),
    ];
    const { rerender } = render(<MessageList busy labels={new Map()} readOnly={false} onRetry={() => {}} messages={messages} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Add a Claude API key in Settings');
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/app/settings');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    rerender(<MessageList busy={false} labels={new Map()} readOnly onRetry={() => {}} messages={messages} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('MessageList context notices', () => {
  it('names each trimmed item "trimmed to fit" and offers no Retry for a forbidden selection', () => {
    const labels = new Map([['readme:a1', 'README · pasted']]);
    const { rerender } = render(
      <MessageList
        busy={false}
        readOnly={false}
        labels={labels}
        onRetry={() => {}}
        messages={[msg({ id: 'a', role: 'assistant', content: 'ok', status: 'complete', trimmed: [{ type: 'readme', id: 'a1' }, { type: 'leads_report', id: 'zz' }] })]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Trimmed context' });
    expect(list).toHaveTextContent('README · pasted trimmed to fit');
    expect(list).toHaveTextContent('LEADS report trimmed to fit');
    rerender(
      <MessageList busy={false} readOnly={false} labels={labels} onRetry={() => {}} messages={[msg({ id: 'a', role: 'assistant', content: '', status: 'error', errorCode: 'forbidden' })]} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("One of the selected items isn't available in this session.");
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('Composer', () => {
  it('Enter sends, Shift+Enter adds a newline, and it is disabled while streaming', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const { rerender } = render(<Composer streaming={false} onSend={onSend} onStop={() => {}} />);
    const box = screen.getByRole('textbox', { name: 'Message Claude' });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(box, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(box).toHaveValue('line one\nline two');
    expect(onSend).not.toHaveBeenCalled();
    await user.type(box, '{Enter}');
    expect(onSend).toHaveBeenCalledWith('line one\nline two');
    expect(box).toHaveValue('');

    await user.type(box, '   {Enter}');
    expect(onSend).toHaveBeenCalledTimes(1); // whitespace only is not sent

    const onStop = vi.fn();
    rerender(<Composer streaming onSend={onSend} onStop={onStop} />);
    expect(screen.getByRole('textbox', { name: 'Message Claude' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalled();
  });
});
