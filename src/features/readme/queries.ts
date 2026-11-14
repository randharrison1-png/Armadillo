import 'server-only';
import { requireUser } from '@/server/auth';
import { getReadmeOverviewFor, type ReadmeOverview } from './service';

/** The session's README list, OS, status and open_readme step for the signed-in user (null if not theirs). */
export async function getReadmeOverview(sessionId: string): Promise<ReadmeOverview | null> {
  const user = await requireUser();
  return getReadmeOverviewFor(user.id, sessionId);
}
