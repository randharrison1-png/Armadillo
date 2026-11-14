import 'server-only';
import { requireUser } from '@/server/auth';
import type { Script, ScriptVersion } from '@/lib/types';
import type { LibraryQuery } from './filters';
import { getScriptWithContentFor, libraryCountsFor, searchScriptsFor, type ScriptListItem } from './service';

export { LIBRARY_LIMIT, type ScriptListItem } from './service';

/** The signed-in user's scripts matching `q` (non-archived; universal scope unless `q.scope` says otherwise). */
export async function searchScripts(q: LibraryQuery = {}): Promise<ScriptListItem[]> {
  const user = await requireUser();
  return searchScriptsFor(user.id, q);
}

/** Sidebar numbers: universal, non-archived scripts per category (grouped count, same predicate as the default table). */
export async function getLibraryCounts() {
  const user = await requireUser();
  return libraryCountsFor(user.id);
}

export async function getScriptWithContent(scriptId: string): Promise<{ script: Script; version: ScriptVersion } | null> {
  const user = await requireUser();
  return getScriptWithContentFor(user.id, scriptId);
}
