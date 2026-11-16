// Deep links into a session's workspace tabs (Sessions & Reports page): /app/sessions/<id>?tab=…
// Pure, no imports: safe in server and client code. tabFromParams (tabFromLink.ts) turns it back into a tab.

export type TabLink =
  | { tab: 'flowchart' | 'requirements' | 'readme' | 'reports' }
  | { tab: 'report' | 'script' | 'proposal'; id: string; name?: string };

export function sessionHref(sessionId: string, link?: TabLink): string {
  const base = `/app/sessions/${sessionId}`;
  if (!link) return base;
  const q = new URLSearchParams({ tab: link.tab });
  if ('id' in link) {
    q.set('id', link.id);
    if (link.name) q.set('name', link.name.slice(0, 120));
  }
  return `${base}?${q.toString()}`;
}
