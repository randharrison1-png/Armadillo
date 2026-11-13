import 'server-only';
import { requireUser } from '@/server/auth';
import type { Script, ScriptVersion } from '@/lib/types';
import { countByCategory, type LibraryQuery } from './filters';
import { getScriptWithContentFor, searchScriptsFor, type ScriptListItem } from './service';

export type { ScriptListItem } from './service';

/** The signed-in user's scripts matching `q` (non-archived; universal scope unless `q.scope` says otherwise). */
export async function searchScripts(q: LibraryQuery = {}): Promise<ScriptListItem[]> {
  const user = await requireUser();
  return searchScriptsFor(user.id, q);
}

/** Sidebar numbers: universal, non-archived scripts per category, from the same query as the table. */
export async function getLibraryCounts() {
  return countByCategory(await searchScripts({ scope: 'universal' }));
}

export async function getScriptWithContent(scriptId: string): Promise<{ script: Script; version: ScriptVersion } | null> {
  const user = await requireUser();
  return getScriptWithContentFor(user.id, scriptId);
}
