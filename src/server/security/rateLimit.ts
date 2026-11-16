import 'server-only';
import type { Tx } from '@/server/db/withUser';

export type RateLimitResult = { ok: boolean; retryAfter: number };

export const PUBLISH_LIMIT = { limit: 10, windowSec: 3600 } as const;
export const EDIT_LIMIT = { limit: 60, windowSec: 3600 } as const;
export const REPORT_LIMIT = { limit: 5, windowSec: 3600 } as const;

/**
 * Counts one hit against `key` in the database's fixed window (check_rate_limit, SECURITY DEFINER).
 * Runs in the caller's transaction: a later rollback also rolls the hit back, so callers that want
 * refused attempts to keep counting (abuse reports) must return rather than throw.
 * `retryAfter` is whole seconds until the window ends when not ok, else 0.
 */
export async function checkRateLimit(tx: Tx, key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
  const [row] = await tx<{ ok: boolean; retry_after: number }[]>`
    select ok, retry_after from public.check_rate_limit(${key}, ${limit}, ${windowSec})`;
  return { ok: row.ok, retryAfter: row.retry_after };
}
