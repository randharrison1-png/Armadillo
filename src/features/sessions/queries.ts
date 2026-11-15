import 'server-only';
import { cache } from 'react';
import { requireUser } from '@/server/auth';
import { getSessionFor, listSessionsFor, type SessionSummary } from './service';

export type { SessionSummary } from './service';

/** Most recently updated sessions for the signed-in user. */
export async function listRecentSessions(limit = 10): Promise<SessionSummary[]> {
  const user = await requireUser();
  return listSessionsFor(user.id, limit);
}

export async function listAllSessions(): Promise<SessionSummary[]> {
  const user = await requireUser();
  return listSessionsFor(user.id);
}

/** Memoised per request: the session layout (404 gate) and the page share one query. */
export const getSession = cache(async (sessionId: string): Promise<SessionSummary | null> => {
  const user = await requireUser();
  return getSessionFor(user.id, sessionId);
});
