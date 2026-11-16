// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
/** Source with comments removed, so prose mentioning a function is not counted as a use. */
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const files = walk(SRC);
const using = (re: RegExp) => files.filter((f) => re.test(code(f))).map(rel).sort();

describe('publishing has no path that skips the dialog', () => {
  it('the server publishPaste function is used only by the pastebin actions module (and defined in create.ts)', () => {
    expect(using(/\bpublishPaste\b/)).toEqual(['src/features/pastebin/actions.ts', 'src/features/pastebin/create.ts']);
    // ...and only actions.ts imports its module
    const importers = files.filter((f) => /from\s*['"](?:\.\/create|@\/features\/pastebin\/create)['"]/.test(code(f))).map(rel);
    expect(importers).toEqual(['src/features/pastebin/actions.ts']);
  });

  it('the client-side publish action is imported only by PublishDialog (and defined in actions.ts)', () => {
    expect(using(/\bpublishPasteAction\b/)).toEqual(['src/features/pastebin/PublishDialog.tsx', 'src/features/pastebin/actions.ts']);
  });

  it('actions.ts is a server-actions module and PublishDialog a client component', () => {
    expect(readFileSync(path.join(SRC, 'features/pastebin/actions.ts'), 'utf8').trimStart().startsWith("'use server'")).toBe(true);
    expect(readFileSync(path.join(SRC, 'features/pastebin/PublishDialog.tsx'), 'utf8').trimStart().startsWith("'use client'")).toBe(true);
  });

  it('only create.ts inserts into paste.pastes; the publish seam is called only by create.ts and the update path', () => {
    expect(using(/insert\s+into\s+paste\.pastes/i)).toEqual(['src/features/pastebin/create.ts']);
    expect(using(/\bvalidateForPublish\s*\(/)).toEqual(['src/features/pastebin/create.ts', 'src/features/pastebin/publish.ts', 'src/features/pastebin/service.ts']);
  });

  it('PublishDialog is only mounted from user-triggered entry points', () => {
    expect(using(/<PublishDialog\b/)).toEqual([
      'src/features/library/ScriptEditorTab.tsx',
      'src/features/library/ScriptTable.tsx',
      'src/features/pastebin/NewPaste.tsx',
    ]);
  });
});
