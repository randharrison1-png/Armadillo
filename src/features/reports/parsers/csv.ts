import type { Finding, LeadsParser, ParsedReport } from './types';
import { clampTitle, MAX_FINDINGS, MAX_LINE, normalizeSeverity, statusFromWord } from './shared';

/*
 * CSV reports (documented best effort): the first non-empty row is a header. It is a findings table
 * when it has a title-like column (title, check, name, finding, rule, control, test, description,
 * item, id) and a status-like column (status, result, outcome, state, compliance, compliant, passed).
 * Optional severity (severity|level|risk|priority) and category (category|section|group|area)
 * columns are used when present. Delimiter: comma, semicolon or tab (the most frequent in the
 * header). Quoted fields (with "" escapes and embedded newlines) are supported. rawLine is the
 * 1-based line where a record starts.
 */

const TITLE_COLS = ['title', 'check', 'name', 'finding', 'rule', 'control', 'test', 'description', 'item', 'id'];
const STATUS_COLS = ['status', 'result', 'outcome', 'state', 'compliance', 'compliant', 'passed'];
const SEVERITY_COLS = ['severity', 'level', 'risk', 'priority'];
const CATEGORY_COLS = ['category', 'section', 'group', 'area'];

type Rec = { fields: string[]; line: number };

function delimiterOf(header: string): string {
  let best = ',';
  let bestN = 0;
  for (const d of [',', ';', '\t']) {
    const n = header.split(d).length - 1;
    if (n > bestN) [best, bestN] = [d, n];
  }
  return best;
}

/** Reads up to `max` records. Linear in the input. */
function records(raw: string, delim: string, max: number): Rec[] {
  const out: Rec[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let any = false;
  const endRecord = () => {
    fields.push(field);
    if (any || fields.length > 1 || fields[0] !== '') out.push({ fields, line: startLine });
    fields = [];
    field = '';
    any = false;
  };
  for (let i = 0; i < raw.length && out.length < max; i++) {
    const c = raw[i]!;
    if (quoted) {
      if (c === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      any = true;
    } else if (c === delim) {
      fields.push(field);
      field = '';
      any = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && raw[i + 1] === '\n') i++;
      endRecord();
      line++;
      startLine = line;
    } else field += c;
  }
  if (out.length < max && (field !== '' || fields.length > 0)) endRecord();
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();
const colOf = (header: string[], names: string[]) => {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
};

function headerOf(raw: string): { header: string[]; delim: string } | null {
  const first = raw.slice(0, MAX_LINE * 2).split(/\r\n|\r|\n/).find((l) => l.trim() !== '');
  if (!first || !/[,;\t]/.test(first)) return null;
  const delim = delimiterOf(first);
  const rec = records(first, delim, 1)[0];
  if (!rec) return null;
  const header = rec.fields.map(norm);
  return colOf(header, TITLE_COLS) >= 0 && colOf(header, STATUS_COLS) >= 0 ? { header, delim } : null;
}

function parseCsv(raw: string): ParsedReport {
  const h = headerOf(raw);
  if (!h) return { parser: 'csv', score: null, findings: [] };
  const [titleI, statusI, sevI, catI] = [colOf(h.header, TITLE_COLS), colOf(h.header, STATUS_COLS), colOf(h.header, SEVERITY_COLS), colOf(h.header, CATEGORY_COLS)];
  const rows = records(raw, h.delim, MAX_FINDINGS + 2);
  const findings: Finding[] = [];
  let truncated = false;
  for (const row of rows.slice(1)) {
    const title = clampTitle(row.fields[titleI] ?? '');
    if (!title) continue;
    if (findings.length >= MAX_FINDINGS) {
      truncated = true;
      break;
    }
    const severity = sevI >= 0 ? normalizeSeverity(row.fields[sevI]) : undefined;
    const category = catI >= 0 ? clampTitle(row.fields[catI] ?? '') : '';
    findings.push({
      title,
      status: statusFromWord(row.fields[statusI] ?? ''),
      ...(severity ? { severity } : {}),
      ...(category ? { category } : {}),
      rawLine: row.line,
    });
  }
  return { parser: 'csv', score: null, findings, ...(truncated ? { truncated } : {}) };
}

export const csvParser: LeadsParser = { id: 'csv', detect: (raw) => headerOf(raw) !== null, parse: parseCsv };
