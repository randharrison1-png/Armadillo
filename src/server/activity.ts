import 'server-only';
import type { Tx } from '@/server/db/withUser';

export type ActivityEvent = {
  action: string;
  entityType: string;
  entityId: string;
  sessionId?: string;
  meta?: Record<string, unknown>;
};

/**
 * Appends to activity_log inside the caller's transaction, so the log entry commits or rolls back
 * with the mutation it describes. The owner is auth.uid() (column default), so `tx` must come from
 * withUser. activity_log is insert-only.
 */
export async function logActivity(tx: Tx, e: ActivityEvent): Promise<void> {
  await tx`
    insert into public.activity_log (session_id, action, entity_type, entity_id, meta)
    values (${e.sessionId ?? null}, ${e.action}, ${e.entityType}, ${e.entityId}, ${tx.json((e.meta ?? {}) as never)})
  `;
}
