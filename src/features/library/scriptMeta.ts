import type { OsType, ScriptCategory, ScriptLanguage, TextEncoding } from '@/lib/types';

const ext = (filename: string) => {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
};

export function languageFor(filename: string): ScriptLanguage {
  switch (ext(filename)) {
    case '.ps1':
      return 'powershell';
    case '.sh':
      return 'bash';
    case '.bat':
    case '.cmd':
      return 'batch';
    case '.md':
      return 'markdown';
    default:
      return 'text';
  }
}

export type TextFormat = { encoding: TextEncoding; lineEnding: 'crlf' | 'lf' | 'mixed' };

/**
 * Format for a script written in the app (uploads keep their detected format). Windows PowerShell 5.1
 * misreads BOM-less UTF-8, so .ps1 gets a BOM; batch files want CRLF; everything else is UTF-8 + LF.
 */
export function defaultFormat(filename: string): TextFormat {
  switch (ext(filename)) {
    case '.ps1':
      return { encoding: 'utf-8-bom', lineEnding: 'crlf' };
    case '.bat':
    case '.cmd':
      return { encoding: 'utf-8', lineEnding: 'crlf' };
    default:
      return { encoding: 'utf-8', lineEnding: 'lf' };
  }
}

export function inferCategory(filename: string): ScriptCategory {
  return ext(filename) === '.sh' ? 'linux' : 'windows';
}

export const defaultFunction = (category: ScriptCategory): 'universal_hardening' | 'leads_audit' =>
  category === 'leads_audit' ? 'leads_audit' : 'universal_hardening';

export const defaultOsCompat = (category: ScriptCategory): OsType[] =>
  category === 'leads_audit' ? ['windows', 'windows_server', 'linux'] : [category];

/** "Harden Win11.v2.ps1" -> "Harden Win11.v2". */
export function nameFromFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
}

export const ENCODING_LABEL: Record<TextEncoding, string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 with BOM',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
};

export const LINE_ENDING_LABEL: Record<TextFormat['lineEnding'], string> = { crlf: 'CRLF', lf: 'LF', mixed: 'Mixed line endings' };

/** "UTF-16 LE · CRLF": how a version is written to disk on download. */
export const formatLabel = (v: { encoding: TextEncoding; line_ending: TextFormat['lineEnding'] }) =>
  `${ENCODING_LABEL[v.encoding]} · ${LINE_ENDING_LABEL[v.line_ending]}`;
