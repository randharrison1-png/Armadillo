import 'server-only';
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

export async function getSession(sessionId: string): Promise<SessionSummary | null> {
  const user = await requireUser();
  return getSessionFor(user.id, sessionId);
}
