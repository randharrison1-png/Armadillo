'use client';

import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { SendHorizontal, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export const MAX_MESSAGE_CHARS = 20_000;

/**
 * Prompt box: Enter sends, Shift+Enter adds a newline. Disabled while a reply streams (Stop is
 * offered instead) and when the session is read-only.
 */
export function Composer({
  streaming,
  disabled,
  disabledReason,
  onSend,
  onStop,
}: {
  streaming: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const hintId = useId();
  const locked = disabled || streaming;
  const tooLong = text.length > MAX_MESSAGE_CHARS;
  const canSend = !locked && text.trim().length > 0 && !tooLong;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    onSend(text);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border bg-bg p-4">
      <div className="flex items-end gap-2">
        <Textarea
          aria-label="Message Claude"
          aria-describedby={hintId}
          aria-invalid={tooLong || undefined}
          placeholder={disabled && disabledReason ? disabledReason : 'Ask Claude about this session…'}
          rows={3}
          value={text}
          disabled={locked}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-60 min-h-20 resize-y text-body"
        />
        {streaming ? (
          <Button type="button" variant="secondary" onClick={onStop}>
            <Square aria-hidden className="size-4" />
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!canSend}>
            <SendHorizontal aria-hidden className="size-4" />
            Send
          </Button>
        )}
      </div>
      <p id={hintId} className="flex justify-between gap-2 text-small text-muted">
        <span>{disabled && disabledReason ? disabledReason : 'Enter to send · Shift+Enter for a new line'}</span>
        {text.length > MAX_MESSAGE_CHARS * 0.9 ? (
          <span className={tooLong ? 'text-danger' : undefined}>
            {text.length.toLocaleString('en-US')} / {MAX_MESSAGE_CHARS.toLocaleString('en-US')}
          </span>
        ) : null}
      </p>
    </form>
  );
}
