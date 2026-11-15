import 'server-only';
import { withUser } from '@/server/db/withUser';
import { checkRateLimit } from '@/server/security/rateLimit';

/**
 * Per-user Claude budgets (fixed windows in check_rate_limit, keys scoped to the caller's own id).
 * They apply to every user, also users with their own saved key: the server cannot tell in
 * advance whether a BYO key will be used for the whole call, and one simple rule is easier to
 * document (docs/deploy.md). Chat turns and structured tool calls share CLAUDE_CALL_LIMIT (one hit
 * per call, even if the tool call's validation retry makes a second request); Settings "Test
 * connection" has its own CLAUDE_TEST_LIMIT.
 */
export const CLAUDE_CALL_LIMIT = { limit: 60, windowSec: 3600 } as const;
export const CLAUDE_TEST_LIMIT = { limit: 10, windowSec: 3600 } as const;

export type ClaudeBudgetKind = 'call' | 'test';

const minutes = (seconds: number) => {
  const n = Math.max(1, Math.ceil(seconds / 60));
  return `${n} minute${n === 1 ? '' : 's'}`;
};

/** User-facing refusal text, e.g. "… Try again in 12 minutes." */
export function budgetMessage(kind: ClaudeBudgetKind, retryAfterSec: number): string {
  const what = kind === 'test' ? `the limit of ${CLAUDE_TEST_LIMIT.limit} connection tests per hour` : `the limit of ${CLAUDE_CALL_LIMIT.limit} Claude requests per hour`;
  return `You have reached ${what}. Try again in ${minutes(retryAfterSec)}.`;
}

/**
 * Counts one hit of the user's Claude budget in its own short transaction (as the user, so the
 * key's self-scoping rule applies) and says whether it is within the limit. Call it right before
 * the upstream request, after every validation that can refuse the call, so a refused call spends
 * nothing.
 */
export async function spendClaudeBudget(userId: string, kind: ClaudeBudgetKind): Promise<{ ok: boolean; retryAfter: number }> {
  const { limit, windowSec } = kind === 'test' ? CLAUDE_TEST_LIMIT : CLAUDE_CALL_LIMIT;
  const key = `${kind === 'test' ? 'claudetest' : 'claude'}:${userId}`;
  return withUser(userId, (tx) => checkRateLimit(tx, key, limit, windowSec));
}
