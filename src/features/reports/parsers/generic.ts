import type { Finding, FindingStatus, LeadsParser, ParsedReport } from './types';
import { clampTitle, MAX_FINDINGS, MAX_LINE, normalizeSeverity, scoreFromLine, SEVERITIES, splitLines, type Score } from './shared';

export { extractScore } from './score';

/*
 * Generic line heuristics (documented best effort; the exact LEADS output is unknown):
 *  - Finding lines carry a status marker: `[+]` pass, `[-]` fail, `[!]` unknown (a warning);
 *    UPPERCASE tokens PASS/PASSED/OK = pass, FAIL/FAILED/FAILURE = fail, WARN/WARNING/ERROR = unknown;
 *    or the same words in brackets in any case (`[pass]`). Lowercase words in prose are never markers.
 *    A line naming more than one distinct status is 'unknown' (ambiguous, never guessed).
 *  - Severity: `[high]` / `(high)`, `severity: high`, or an uppercase HIGH/CRITICAL/MEDIUM/LOW/INFO token.
 *  - Category: the latest header line before the finding: `== Accounts ==`, `### Firewall`, `--- Services ---`.
 *  - Score: last line matching `84/100 points`, `84 out of 100`, `Score: 84` (see scoreFromLine).
 *  - Title: the line without its marker and severity token, truncated to 300 characters.
 *  - Only the first 5,000 finding lines are kept; `truncated` is set when there were more.
 */

const SYMBOL_RE = /\[([+\-!])\]/;
const BRACKET_WORD_RE = /\[(pass(?:ed)?|fail(?:ed|ure)?|ok|warn(?:ing)?|error)\]/i;
const TOKEN_RE = /\b(PASS(?:ED)?|FAIL(?:ED|URE)?|OK|WARN(?:ING)?|ERROR)\b/g;
const HEADER_RE = /^\s*(?:={2,}|#{1,6}|-{3,})\s*(.*?)\s*(?:={2,}|#{1,6}|-{3,})?\s*$/;
const SEV_BRACKET_RE = /[[(]\s*(critical|high|medium|low|info(?:rmational)?)\s*[\])]/i;
const SEV_LABEL_RE = /\bseverity\s*[:=]\s*(critical|high|medium|low|info(?:rmational)?)\b/i;
const SEV_TOKEN_RE = /\b(CRITICAL|HIGH|MEDIUM|LOW|INFO)\b/;

function wordStatus(word: string): FindingStatus {
  const w = word.toUpperCase();
  if (w.startsWith('PASS') || w === 'OK') return 'pass';
  if (w.startsWith('FAIL')) return 'fail';
  return 'unknown'; // WARN, WARNING, ERROR
}

type Marker = { status: FindingStatus; index: number; length: number; ambiguous: boolean };

function findMarker(line: string): Marker | null {
  const found: Marker[] = [];
  const sym = SYMBOL_RE.exec(line);
  if (sym) found.push({ status: sym[1] === '+' ? 'pass' : sym[1] === '-' ? 'fail' : 'unknown', index: sym.index, length: sym[0].length, ambiguous: false });
  const br = BRACKET_WORD_RE.exec(line);
  if (br) found.push({ status: wordStatus(br[1]!), index: br.index, length: br[0].length, ambiguous: false });
  for (const m of line.matchAll(TOKEN_RE)) found.push({ status: wordStatus(m[1]!), index: m.index, length: m[0].length, ambiguous: false });
  if (found.length === 0) return null;
  found.sort((a, b) => a.index - b.index);
  const first = found[0]!;
  const ambiguous = found.some((f) => f.status !== first.status);
  return { ...first, status: ambiguous ? 'unknown' : first.status, ambiguous };
}

function takeSeverity(text: string): { severity?: string; rest: string } {
  for (const re of [SEV_LABEL_RE, SEV_BRACKET_RE, SEV_TOKEN_RE]) {
    const m = re.exec(text);
    if (m) {
      const severity = normalizeSeverity(m[1]);
      if (severity) return { severity, rest: text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length) };
    }
  }
  return { rest: text };
}

const TRIM_EDGES = /^[\s:\-–—|.=>*]+|[\s:\-–—|=]+$/g;

export function genericParse(raw: string): ParsedReport {
  const lines = splitLines(raw);
  const findings: Finding[] = [];
  let truncated = false;
  let category: string | undefined;
  let score: Score | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.length > MAX_LINE ? lines[i]!.slice(0, MAX_LINE) : lines[i]!;
    if (line.trim() === '') continue;
    const marker = findMarker(line);
    if (!marker) {
      const header = HEADER_RE.exec(line);
      if (header && /[A-Za-z0-9]/.test(header[1] ?? '')) {
        category = clampTitle(header[1]!);
        continue;
      }
      const s = scoreFromLine(line);
      if (s) score = s;
      continue;
    }
    if (findings.length >= MAX_FINDINGS) {
      truncated = true;
      continue;
    }
    // An ambiguous line keeps the whole line as its title.
    const stripped = marker.ambiguous ? line : line.slice(0, marker.index) + ' ' + line.slice(marker.index + marker.length);
    const { severity, rest } = takeSeverity(stripped);
    const title = clampTitle(rest.replace(TRIM_EDGES, '')) || clampTitle(line);
    findings.push({ title, status: marker.status, ...(severity ? { severity } : {}), ...(category ? { category } : {}), rawLine: i + 1 });
  }

  return { parser: 'generic', score: score?.score ?? null, scoreMax: score?.scoreMax ?? null, findings, ...(truncated ? { truncated } : {}) };
}

/** The generic fallback. It accepts any text; parseLeadsReport demotes it to 'raw' when it finds nothing. */
export const genericParser: LeadsParser = { id: 'generic', detect: () => true, parse: genericParse };

export type SeverityGroup = { severity: string; findings: Finding[] };

/** Findings grouped by severity, most severe first, findings without a severity last under 'unspecified'. */
export function groupBySeverity(findings: Finding[]): SeverityGroup[] {
  const groups: SeverityGroup[] = [];
  for (const severity of [...SEVERITIES, 'unspecified']) {
    const hit = findings.filter((f) => (f.severity ?? 'unspecified') === severity);
    if (hit.length) groups.push({ severity, findings: hit });
  }
  return groups;
}
