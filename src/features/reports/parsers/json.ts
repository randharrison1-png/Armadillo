import type { Finding, LeadsParser, ParsedReport } from './types';
import { clampTitle, MAX_FINDINGS, normalizeSeverity, statusFromWord } from './shared';

/*
 * JSON reports (documented best effort): an array of objects, or an object holding such an array
 * (findings / results / checks / items / controls / audit / tests / rules, else the first array of
 * objects). An item is a finding when it has a title-like key (title, name, check, rule, ...) AND
 * a status-like key (status, result, outcome, state, passed, ...). Status words map via
 * statusFromWord (booleans: true = pass); anything else is 'unknown'. Severity/category come from
 * severity|level|risk|priority and category|section|group|area. A top-level numeric `score`
 * (optionally with max_score / out_of) is the reported score.
 */

const TITLE_KEYS = ['title', 'check', 'name', 'finding', 'rule', 'control', 'test', 'description', 'summary', 'message', 'id'];
const STATUS_KEYS = ['status', 'result', 'outcome', 'state', 'compliance', 'compliant', 'passed', 'pass'];
const SEVERITY_KEYS = ['severity', 'level', 'risk', 'priority'];
const CATEGORY_KEYS = ['category', 'section', 'group', 'area'];
const LIST_KEYS = ['findings', 'results', 'checks', 'items', 'controls', 'audit', 'tests', 'rules'];
const SCORE_KEYS = ['score', 'points', 'total_score', 'totalScore'];
const MAX_KEYS = ['max_score', 'maxScore', 'out_of', 'outOf', 'possible', 'max_points', 'maxPoints'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parsed JSON container (object or array), or undefined. Nothing is cached: a cached 25 MB input would stay pinned. */
function parseContainer(raw: string): unknown {
  const t = raw.trim();
  if (!t.startsWith('[') && !t.startsWith('{')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

const firstKey = (o: Obj, keys: string[]) => keys.find((k) => k in o && o[k] !== null && o[k] !== undefined && o[k] !== '');

function numberOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function locateItems(root: unknown): { items: unknown[]; indent: number } | null {
  if (Array.isArray(root)) return { items: root, indent: 2 };
  if (!isObj(root)) return null;
  const hasObjects = (v: unknown): v is unknown[] => Array.isArray(v) && v.some(isObj);
  const key = LIST_KEYS.find((k) => hasObjects(root[k])) ?? Object.keys(root).find((k) => hasObjects(root[k]));
  return key ? { items: root[key] as unknown[], indent: 4 } : null;
}

function parseJson(raw: string): ParsedReport {
  const root = parseContainer(raw);
  const findings: Finding[] = [];
  let truncated = false;
  let score: number | null = null;
  let scoreMax: number | null = null;

  if (isObj(root)) {
    const sk = SCORE_KEYS.find((k) => numberOf(root[k]) !== null);
    if (sk) score = numberOf(root[sk]);
    const mk = MAX_KEYS.find((k) => numberOf(root[k]) !== null);
    if (score !== null && mk) {
      const max = numberOf(root[mk]);
      scoreMax = max !== null && max > 0 && score <= max ? max : null;
    }
  }

  const located = locateItems(root);
  if (located) {
    // rawLine: where each item's pretty-printed text starts in `raw` (null when it cannot be located).
    let cursor = 0;
    let line = 1;
    // An item that cannot be located (minified, re-formatted or escaped differently) gets rawLine null.
    // A failed search is O(input), so after MAX_MISSES misses no more searches are made (the rest are null).
    let misses = 0;
    const MAX_MISSES = 3;
    const pad = ' '.repeat(located.indent);
    for (const item of located.items) {
      if (!isObj(item)) continue;
      const tk = firstKey(item, TITLE_KEYS);
      const stk = STATUS_KEYS.find((k) => k in item && item[k] !== null && item[k] !== undefined);
      const title = tk && (typeof item[tk] === 'string' || typeof item[tk] === 'number') ? clampTitle(String(item[tk])) : '';
      if (!title || !stk) continue;
      if (findings.length >= MAX_FINDINGS) {
        truncated = true;
        break;
      }
      let rawLine: number | null = null;
      const at = misses < MAX_MISSES ? raw.indexOf(JSON.stringify(item, null, 2).split('\n').join('\n' + pad), cursor) : -1;
      if (misses < MAX_MISSES && at < 0) misses++;
      if (at >= 0) {
        for (let i = cursor; i < at; i++) if (raw.charCodeAt(i) === 10) line++;
        cursor = at;
        rawLine = line;
      }
      const sv = item[stk];
      const status = typeof sv === 'boolean' ? (sv ? 'pass' : 'fail') : statusFromWord(String(sv));
      const sevKey = firstKey(item, SEVERITY_KEYS);
      const catKey = firstKey(item, CATEGORY_KEYS);
      const severity = sevKey ? normalizeSeverity(item[sevKey]) : undefined;
      const category = catKey && typeof item[catKey] === 'string' ? clampTitle(item[catKey] as string) : undefined;
      findings.push({ title, status, ...(severity ? { severity } : {}), ...(category ? { category } : {}), rawLine });
    }
  }
  return { parser: 'json', score, scoreMax, findings, ...(truncated ? { truncated } : {}) };
}

export const jsonParser: LeadsParser = {
  id: 'json',
  detect: (raw) => parseContainer(raw) !== undefined,
  parse: parseJson,
};
