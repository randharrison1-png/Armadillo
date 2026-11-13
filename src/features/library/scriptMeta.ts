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
