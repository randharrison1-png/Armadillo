import type { FindingStatus } from './types';

export const MAX_FINDINGS = 5000;
export const MAX_TITLE = 300;
/** Only this many leading characters of a line are examined. */
export const MAX_LINE = 2000;

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

/** Splits on CRLF, CR or LF. The 1-based index into this array is Finding.rawLine everywhere. */
export const splitLines = (raw: string): string[] => raw.split(/\r\n|\r|\n/);

const PASS_WORDS = new Set(['pass', 'passed', 'ok', 'success', 'successful', 'compliant', 'true', 'secure']);
const FAIL_WORDS = new Set(['fail', 'failed', 'failure', 'noncompliant', 'non-compliant', 'non compliant', 'false', 'insecure']);

/** Maps a status word from structured output. Anything not clearly pass or fail is 'unknown' (never a guess). */
export function statusFromWord(word: string): FindingStatus {
  const w = word.trim().toLowerCase();
  if (PASS_WORDS.has(w)) return 'pass';
  if (FAIL_WORDS.has(w)) return 'fail';
  return 'unknown';
}

const SEVERITY_ALIASES: Record<string, string> = {
  critical: 'critical',
  crit: 'critical',
  severe: 'critical',
  high: 'high',
  medium: 'medium',
  moderate: 'medium',
  med: 'medium',
  low: 'low',
  info: 'info',
  informational: 'info',
};

export function normalizeSeverity(value: unknown): string | undefined {
  return typeof value === 'string' ? SEVERITY_ALIASES[value.trim().toLowerCase()] : undefined;
}

export function clampTitle(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t;
}

export type Score = { score: number; scoreMax: number | null };

const NUM = String.raw`(\d{1,9}(?:\.\d{1,4})?)`;
const POINTS_RE = new RegExp(String.raw`${NUM}\s*/\s*${NUM}\s*points?\b`, 'i');
const OUT_OF_RE = new RegExp(String.raw`${NUM}\s+out\s+of\s+${NUM}\b`, 'i');
const SCORE_RE = new RegExp(String.raw`\bscore\b\s*[:=]?\s*${NUM}(?:\s*/\s*${NUM})?`, 'i');

/** One line's score, or null. Patterns: `84/100 points`, `84 out of 100`, `Score: 84`, `Score: 84/100`. */
export function scoreFromLine(line: string): Score | null {
  const l = line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
  if (!/\d/.test(l)) return null;
  let m = POINTS_RE.exec(l);
  let x: number | undefined;
  let y: number | undefined;
  if (m) {
    x = Number(m[1]);
    y = Number(m[2]);
  } else if ((m = OUT_OF_RE.exec(l))) {
    // "12 out of 15 checks passed" is not a score: require 100, or the word points/score on the line.
    if (Number(m[2]) === 100 || /point|score/i.test(l)) {
      x = Number(m[1]);
      y = Number(m[2]);
    }
  } else if ((m = SCORE_RE.exec(l))) {
    x = Number(m[1]);
    y = m[2] === undefined ? undefined : Number(m[2]);
  }
  if (x === undefined || !Number.isFinite(x)) return null;
  if (y !== undefined && (!Number.isFinite(y) || y <= 0 || x > y)) return null;
  return { score: x, scoreMax: y ?? null };
}
