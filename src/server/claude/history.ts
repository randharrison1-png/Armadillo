import 'server-only';

export type HistoryRow = { role: 'user' | 'assistant'; content: string; status: 'streaming' | 'complete' | 'error' };
export type HistoryMessage = { role: 'user' | 'assistant'; content: string };

/** Defaults for the prior-turn window sent with each request (~30k tokens of history at most). */
export const HISTORY_LIMITS = { maxMessages: 40, maxChars: 120_000 } as const;

/**
 * Prior turns for the Messages API, oldest first: only `complete` messages with text (errored or
 * still-streaming replies are left out), the newest ones that fit `maxMessages` / `maxChars`,
 * starting with a user turn, with consecutive same-role messages merged (a user message whose reply
 * failed is followed by the next user message).
 */
export function buildHistory(rows: readonly HistoryRow[], limits: { maxMessages: number; maxChars: number } = HISTORY_LIMITS): HistoryMessage[] {
  const usable = rows.filter((r) => r.status === 'complete' && r.content.trim() !== '');
  const picked: HistoryMessage[] = [];
  let chars = 0;
  for (let i = usable.length - 1; i >= 0 && picked.length < limits.maxMessages; i--) {
    const len = usable[i].content.length;
    if (chars + len > limits.maxChars) break;
    chars += len;
    picked.unshift({ role: usable[i].role, content: usable[i].content });
  }
  while (picked.length && picked[0].role !== 'user') picked.shift();
  const merged: HistoryMessage[] = [];
  for (const m of picked) {
    const prev = merged.at(-1);
    if (prev && prev.role === m.role) prev.content = `${prev.content}\n\n${m.content}`;
    else merged.push({ ...m });
  }
  return merged;
}

/** Conversation title: the first ~60 characters of the first user message, whitespace collapsed. */
export function conversationTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 60).trimEnd()}…` : flat;
}
