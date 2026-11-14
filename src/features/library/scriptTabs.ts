import type { TabDescriptor } from '@/lib/types';

/**
 * Workspace tab descriptors for scripts (client-safe, no server imports).
 *
 * resourceId formats:
 *  - kind 'script', editor:          `<scriptId>`                      key `script:<scriptId>`
 *  - kind 'script', read-only view:  `<scriptId>@<versionId>`          key `script:<scriptId>@<versionId>`
 *  - kind 'diff':                    `<scriptId>:<fromId>..<toId>`     key `diff:<scriptId>:<fromId>..<toId>`
 * All ids are UUIDs; versions are referenced by id (immutable), never by number. Titles carry the
 * version numbers for display only.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SCRIPT_RE = new RegExp(`^(${UUID})(?:@(${UUID}))?$`, 'i');
const DIFF_RE = new RegExp(`^(${UUID}):(${UUID})\\.\\.(${UUID})$`, 'i');

export const isUuid = (s: string) => new RegExp(`^${UUID}$`, 'i').test(s);

/** The editable editor tab for a script (one per script per workspace). */
export function scriptTab(scriptId: string, filename: string): TabDescriptor {
  return { key: `script:${scriptId}`, kind: 'script', title: filename, resourceId: scriptId };
}

/** A read-only view of one version. */
export function versionViewTab(scriptId: string, versionId: string, filename: string, versionNo: number): TabDescriptor {
  const resourceId = `${scriptId}@${versionId}`;
  return { key: `script:${resourceId}`, kind: 'script', title: `${filename} v${versionNo}`, resourceId };
}

/** A side-by-side comparison of two versions (`from` on the left). */
export function diffTab(
  scriptId: string,
  from: { id: string; no: number },
  to: { id: string; no: number },
  filename: string,
): TabDescriptor {
  const resourceId = `${scriptId}:${from.id}..${to.id}`;
  return { key: `diff:${resourceId}`, kind: 'diff', title: `${filename} v${from.no} ↔ v${to.no}`, resourceId };
}

export function parseScriptResourceId(id: string): { scriptId: string; versionId: string | null } | null {
  const m = SCRIPT_RE.exec(id);
  return m ? { scriptId: m[1]!, versionId: m[2] ?? null } : null;
}

export function parseDiffResourceId(id: string): { scriptId: string; fromVersionId: string; toVersionId: string } | null {
  const m = DIFF_RE.exec(id);
  return m ? { scriptId: m[1]!, fromVersionId: m[2]!, toVersionId: m[3]! } : null;
}

export const downloadHref = (versionId: string) => `/api/files/download/${versionId}`;
