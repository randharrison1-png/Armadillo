'use server';

import { requireUser } from '@/server/auth';
import { stopReplyFor } from '@/server/claude/turns';
import type { ResourceRef } from '@/lib/types';
import { getClaudeTabFor, getContextOptionsFor, getConversationFor } from './service';
import type { ChatMessage, ClaudeTabData, ContextOptions, ConversationSummary } from './types';

/** The session's conversations and status for the Claude tab; null when the session is not the user's. */
export async function loadClaudeTab(sessionId: string): Promise<ClaudeTabData | null> {
  const user = await requireUser();
  return getClaudeTabFor(user.id, String(sessionId));
}

/** One conversation's messages (oldest first); null when it is not the user's. */
export async function loadConversation(conversationId: string): Promise<{ conversation: ConversationSummary; messages: ChatMessage[] } | null> {
  const user = await requireUser();
  return getConversationFor(user.id, String(conversationId));
}

const REF_TYPES = new Set<ResourceRef['type']>(['readme', 'script_version', 'leads_report', 'evidence']);

/** Context-picker entries (labels only) for the session; `selected` adds already-selected library script versions. */
export async function loadContextOptions(sessionId: string, selected: ResourceRef[]): Promise<ContextOptions | null> {
  const user = await requireUser();
  const refs = (Array.isArray(selected) ? selected : [])
    .filter((r): r is ResourceRef => !!r && typeof r === 'object' && REF_TYPES.has(r.type) && typeof r.id === 'string')
    .map((r) => ({ type: r.type, id: r.id }));
  return getContextOptionsFor(user.id, String(sessionId), refs);
}

/** Stop button: stops the user's streaming reply (its partial text is kept). */
export async function stopClaudeReply(messageId: string): Promise<{ ok: boolean }> {
  const user = await requireUser();
  return { ok: await stopReplyFor(user.id, String(messageId)) };
}
