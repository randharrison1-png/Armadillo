import type { Script } from '@/lib/types';
import { describe, expect, it } from 'vitest';
import { countByCategory, filterScripts, hasActiveFilters, parseLibraryQuery } from '@/features/library/filters';
import { defaultFormat, defaultFunction, defaultOsCompat, inferCategory, languageFor, nameFromFilename } from '@/features/library/scriptMeta';

type Row = Pick<Script, 'session_id' | 'category' | 'function'> & { id: string };
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  session_id: null,
  category: 'windows',
  function: 'universal_hardening',
  ...over,
});

const rows: Row[] = [
  row('win'),
  row('lin', { category: 'linux' }),
  row('audit', { category: 'leads_audit', function: 'leads_audit' }),
  row('sess', { session_id: 's1', function: 'session_generated' }),
];

describe('library filters', () => {
  it('session-generated scripts hidden from default universal view', () => {
    const q = parseLibraryQuery({});
    expect(q.scope).toBe('universal');
    expect(filterScripts(rows, q).map((r) => r.id)).toEqual(['win', 'lin', 'audit']);
  });

  it('scope session shows only session scripts; all shows everything', () => {
    expect(filterScripts(rows, { scope: 'session' }).map((r) => r.id)).toEqual(['sess']);
    expect(filterScripts(rows, { scope: 'all' })).toHaveLength(4);
  });

  it('filters by category and function', () => {
    expect(filterScripts(rows, { category: 'linux' }).map((r) => r.id)).toEqual(['lin']);
    expect(filterScripts(rows, { fn: 'leads_audit' }).map((r) => r.id)).toEqual(['audit']);
    expect(filterScripts(rows, { scope: 'all', category: 'windows' }).map((r) => r.id)).toEqual(['win', 'sess']);
  });

  it('parses and validates search params, ignoring junk', () => {
    expect(parseLibraryQuery({ q: '  Set-Net  ', category: 'linux', fn: 'leads_audit', scope: 'all' })).toEqual({
      text: 'Set-Net',
      category: 'linux',
      fn: 'leads_audit',
      scope: 'all',
    });
    expect(parseLibraryQuery({ category: 'nope', fn: 'x', scope: 'y', q: ['a', 'b'] })).toEqual({ scope: 'universal' });
  });

  it('hasActiveFilters ignores the default scope', () => {
    expect(hasActiveFilters({ scope: 'universal' })).toBe(false);
    expect(hasActiveFilters({ scope: 'all' })).toBe(true);
    expect(hasActiveFilters({ scope: 'universal', text: 'x' })).toBe(true);
  });

  it('counts universal scripts per category (the sidebar numbers)', () => {
    expect(countByCategory(rows)).toEqual({ windows: 1, linux: 1, leads_audit: 1 });
  });
});

describe('script metadata defaults', () => {
  it('language from extension', () => {
    expect(languageFor('a.ps1')).toBe('powershell');
    expect(languageFor('a.SH')).toBe('bash');
    expect(languageFor('a.bat')).toBe('batch');
    expect(languageFor('a.cmd')).toBe('batch');
    expect(languageFor('a.md')).toBe('markdown');
    expect(languageFor('a.txt')).toBe('text');
  });
  it('encoding and line ending defaults for created scripts', () => {
    expect(defaultFormat('a.ps1')).toEqual({ encoding: 'utf-8-bom', lineEnding: 'crlf' });
    expect(defaultFormat('a.bat')).toEqual({ encoding: 'utf-8', lineEnding: 'crlf' });
    expect(defaultFormat('a.cmd')).toEqual({ encoding: 'utf-8', lineEnding: 'crlf' });
    expect(defaultFormat('a.sh')).toEqual({ encoding: 'utf-8', lineEnding: 'lf' });
    expect(defaultFormat('a.md')).toEqual({ encoding: 'utf-8', lineEnding: 'lf' });
  });
  it('infers category, function, OS and name', () => {
    expect(inferCategory('a.ps1')).toBe('windows');
    expect(inferCategory('a.bat')).toBe('windows');
    expect(inferCategory('a.sh')).toBe('linux');
    expect(inferCategory('a.txt')).toBe('windows');
    expect(defaultFunction('leads_audit')).toBe('leads_audit');
    expect(defaultFunction('linux')).toBe('universal_hardening');
    expect(defaultOsCompat('linux')).toEqual(['linux']);
    expect(defaultOsCompat('leads_audit')).toEqual(['windows', 'windows_server', 'linux']);
    expect(nameFromFilename('Harden Win11.v2.ps1')).toBe('Harden Win11.v2');
  });
});
