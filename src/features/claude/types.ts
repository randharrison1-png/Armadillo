// Client-safe types for the Claude tab (no runtime code).
import type { ResourceRef } from '@/lib/types';
import type { ConversationMode, MessageRole, MessageStatus } from '@/server/db/types';

export type { ConversationMode };

export type ConversationSummary = { id: string; mode: ConversationMode; title: string | null; updatedAt: string };

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  refs: ResourceRef[];
  status: MessageStatus;
  /** The prompt's clientRequestId; a reply carries the same value as its prompt. */
  requestId: string | null;
  createdAt: string;
  /** The reply was stopped by the user. */
  stopped?: boolean;
  /** Failure code of an errored reply (e.g. 'overloaded', 'no_key', 'interrupted'). */
  errorCode?: string;
  /** User-facing failure text (only known in the browser right after a failure). */
  errorMessage?: string;
  /** Selected items that were shortened to fit Claude's context limit for this reply. */
  trimmed?: ResourceRef[];
  /** The browser has not yet received this message's server id. */
  local?: boolean;
};

export type ClaudeTabData = {
  sessionStatus: 'active' | 'completed';
  conversations: ConversationSummary[];
  /** A Claude key is available (the user's own or the server's). Never the key itself. */
  keyConfigured: boolean;
};

export type ContextOption = { ref: ResourceRef; label: string; detail?: string };
export type ContextOptions = {
  readmes: ContextOption[];
  scriptVersions: ContextOption[];
  leadsReports: ContextOption[];
  evidence: ContextOption[];
};

export const MODE_LABEL: Record<ConversationMode, string> = {
  general: 'General',
  adaptation: 'Adaptation',
  remediation: 'Remediation',
};

export const REF_TYPE_LABEL: Record<ResourceRef['type'], string> = {
  readme: 'README',
  script_version: 'Script version',
  leads_report: 'LEADS report',
  evidence: 'Evidence',
};

export const refKey = (r: ResourceRef) => `${r.type}:${r.id}`;

export type TokenUsage = { input_tokens: number; output_tokens: number };

/** SSE events of POST /api/claude/messages (`event: <name>\ndata: <json>\n\n`). */
export type ClaudeStreamEvents = {
  /** First event: ids of the turn (the conversation is created with the first message). `replay`: an earlier result is being resent. */
  start: { conversationId: string; userMessageId: string; assistantMessageId: string; replay: boolean };
  delta: { text: string };
  done: { messageId: string; conversationId: string; usage: TokenUsage | null; model: string | null; trimmed?: ResourceRef[] };
  error: { message: string; retryable: boolean; code: string; messageId?: string };
};
