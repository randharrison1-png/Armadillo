import { csvParser } from './csv';
import { genericParser } from './generic';
import { jsonParser } from './json';
import { clampTitle, MAX_FINDINGS } from './shared';
import type { Finding, LeadsParser, ParsedReport } from './types';

export type { Finding, FindingStatus, LeadsParser, ParsedReport } from './types';
export { MAX_FINDINGS, MAX_TITLE } from './shared';

/**
 * Registered LEADS parsers, tried in order: the first whose `detect` matches wins. To support a
 * new LEADS output format, add a LeadsParser here (before the generic fallback, which is implicit).
 */
export const PARSERS: LeadsParser[] = [jsonParser, csvParser];

const rawResult = (parseError?: string): ParsedReport => ({ parser: 'raw', score: null, findings: [], ...(parseError ? { parseError } : {}) });

const STATUSES = new Set(['pass', 'fail', 'unknown']);

/** Enforces the invariants no parser may break: capped findings and titles, valid statuses and lines. */
function normalize(r: ParsedReport): ParsedReport {
  const findings: Finding[] = [];
  for (const f of r.findings ?? []) {
    if (findings.length >= MAX_FINDINGS) break;
    const title = clampTitle(String(f.title ?? ''));
    if (!title || !STATUSES.has(f.status)) continue;
    findings.push({
      title,
      status: f.status,
      ...(f.severity ? { severity: String(f.severity).slice(0, 40) } : {}),
      ...(f.category ? { category: clampTitle(String(f.category)) } : {}),
      rawLine: Number.isInteger(f.rawLine) && f.rawLine >= 1 ? f.rawLine : 1,
    });
  }
  const score = typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : null;
  // Nothing found: keep only the raw text.
  if (findings.length === 0 && score === null) return rawResult(r.parseError);
  const truncated = r.truncated || (r.findings?.length ?? 0) > findings.length;
  return {
    parser: r.parser,
    score,
    ...(r.scoreMax !== undefined ? { scoreMax: r.scoreMax } : {}),
    findings,
    ...(truncated ? { truncated: true } : {}),
    ...(r.parseError ? { parseError: r.parseError } : {}),
    ...(r.parseNote ? { parseNote: r.parseNote } : {}),
  };
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * Parses LEADS output text: the first matching registered parser, else the generic line
 * heuristics, else `{ parser: 'raw', findings: [] }`. NEVER throws: a failing parser leaves the
 * report as raw text with `parseError` set. `parsers` is injectable for tests.
 */
export function parseLeadsReport(raw: string, parsers: LeadsParser[] = PARSERS): ParsedReport {
  try {
    for (const p of parsers) {
      let hit = false;
      try {
        hit = p.detect(raw);
      } catch {
        hit = false;
      }
      if (!hit) continue;
      try {
        return normalize(p.parse(raw));
      } catch (e) {
        return rawResult(describe(e));
      }
    }
    return normalize(genericParser.parse(raw));
  } catch (e) {
    return rawResult(describe(e));
  }
}
