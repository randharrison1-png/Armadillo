import type { Script, ScriptCategory, ScriptFunction } from '@/lib/types';

/** universal = session_id null (the default view); session = session-generated scripts; all = both. */
export type LibraryScope = 'universal' | 'session' | 'all';

export type LibraryQuery = { text?: string; category?: ScriptCategory; fn?: ScriptFunction; scope?: LibraryScope };

export const CATEGORIES = ['windows', 'windows_server', 'linux', 'leads_audit'] as const satisfies readonly ScriptCategory[];
export const FUNCTIONS = ['universal_hardening', 'leads_audit', 'session_generated'] as const satisfies readonly ScriptFunction[];
export const SCOPES = ['universal', 'session', 'all'] as const satisfies readonly LibraryScope[];

export const CATEGORY_LABEL: Record<ScriptCategory, string> = {
  windows: 'Windows',
  windows_server: 'Windows Server',
  linux: 'Linux',
  leads_audit: 'LEADS/Audit',
};
export const FUNCTION_LABEL: Record<ScriptFunction, string> = {
  universal_hardening: 'Universal hardening',
  leads_audit: 'LEADS/Audit',
  session_generated: 'Session-generated',
};
export const SCOPE_LABEL: Record<LibraryScope, string> = {
  universal: 'Universal scripts',
  session: 'Session-generated',
  all: 'All scripts',
};

type Params = Record<string, string | string[] | undefined>;

const pick = <T extends string>(v: string | string[] | undefined, allowed: readonly T[]): T | undefined =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

/** URL search params -> query. Unknown values are ignored; scope defaults to 'universal'. */
export function parseLibraryQuery(sp: Params): LibraryQuery {
  const q: LibraryQuery = { scope: pick(sp.scope, SCOPES) ?? 'universal' };
  const text = typeof sp.q === 'string' ? sp.q.trim() : '';
  if (text) q.text = text;
  const category = pick(sp.category, CATEGORIES);
  if (category) q.category = category;
  const fn = pick(sp.fn, FUNCTIONS);
  if (fn) q.fn = fn;
  return q;
}

/** True when anything beyond the default universal view is selected (drives the "no matches" empty state). */
export function hasActiveFilters(q: LibraryQuery): boolean {
  return Boolean(q.text || q.category || q.fn || (q.scope && q.scope !== 'universal'));
}

type Filterable = Pick<Script, 'session_id' | 'category' | 'function'>;

/** Category / function / scope filtering (the text search and archive exclusion happen in SQL). */
export function filterScripts<T extends Filterable>(rows: readonly T[], q: LibraryQuery): T[] {
  const scope = q.scope ?? 'universal';
  return rows.filter(
    (r) =>
      (scope === 'all' || (scope === 'universal' ? r.session_id === null : r.session_id !== null)) &&
      (!q.category || r.category === q.category) &&
      (!q.fn || r.function === q.fn),
  );
}

/** Per-category counts of universal scripts: the numbers beside the sidebar's Script Library children. */
export function countByCategory(rows: readonly Pick<Script, 'session_id' | 'category'>[]): Partial<Record<ScriptCategory, number>> {
  const counts: Partial<Record<ScriptCategory, number>> = {};
  for (const r of rows) if (r.session_id === null) counts[r.category] = (counts[r.category] ?? 0) + 1;
  return counts;
}
