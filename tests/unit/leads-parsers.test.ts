import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLeadsReport, MAX_FINDINGS, type LeadsParser } from '@/features/reports/parsers';
import { extractScore, groupBySeverity } from '@/features/reports/parsers/generic';
import { htmlToText, reportTextFromBytes } from '@/features/reports/text';

const FIX = path.join(import.meta.dirname, '..', 'fixtures', 'leads');
const bytes = (name: string) => new Uint8Array(readFileSync(path.join(FIX, name)));
const text = (name: string) => readFileSync(path.join(FIX, name), 'utf8');

describe('parseLeadsReport', () => {
  it('unknown format falls back to raw without throwing', () => {
    const r = parseLeadsReport(text('unknown-format.txt'));
    expect(r).toEqual({ parser: 'raw', score: null, findings: [] });
    expect(() => parseLeadsReport('')).not.toThrow();
    expect(parseLeadsReport('').parser).toBe('raw');
    expect(() => parseLeadsReport('\u0000￿<<<>>>[[[ {{{ \n\r\r\n'.repeat(50))).not.toThrow();
  });

  it('a parser that throws never escapes: raw with a parse_error note', () => {
    const boom: LeadsParser = {
      id: 'boom',
      detect: () => true,
      parse: () => {
        throw new Error('kaput');
      },
    };
    const r = parseLeadsReport('[+] fine', [boom]);
    expect(r.parser).toBe('raw');
    expect(r.findings).toEqual([]);
    expect(r.parseError).toMatch(/kaput/);
    const badDetect: LeadsParser = {
      id: 'bad',
      detect: () => {
        throw new Error('detect blew up');
      },
      parse: () => ({ parser: 'bad', score: null, findings: [] }),
    };
    expect(parseLeadsReport('[+] fine', [badDetect]).parser).toBe('generic');
  });

  it('uses the first registered parser whose detect matches', () => {
    const first: LeadsParser = {
      id: 'first',
      detect: (raw) => raw.includes('MAGIC'),
      parse: () => ({ parser: 'first', score: 1, findings: [{ title: 'x', status: 'pass', rawLine: 1 }] }),
    };
    const second: LeadsParser = { ...first, id: 'second', parse: () => ({ parser: 'second', score: 2, findings: [] }) };
    expect(parseLeadsReport('MAGIC', [first, second]).parser).toBe('first');
    expect(parseLeadsReport('[+] ok line', [first, second]).parser).toBe('generic');
  });

  it('parses [+]/[-]/[!] marker lines and the score (plain-markers fixture)', () => {
    const r = parseLeadsReport(text('plain-markers.txt'));
    expect(r.parser).toBe('generic');
    expect(r.score).toBe(84);
    expect(r.scoreMax).toBe(100);
    expect(r.findings.map((f) => [f.status, f.title])).toEqual([
      ['pass', 'Guest account is disabled'],
      ['fail', 'Password history is not enforced (remembered passwords: 0)'],
      ['pass', 'Windows Firewall enabled for all profiles'],
      ['fail', 'Remote Desktop is enabled'],
      ['unknown', 'Automatic updates are set to notify only'],
      ['pass', 'SMBv1 is disabled'],
    ]);
    // 1-based line numbers into the raw text.
    expect(r.findings[0]!.rawLine).toBe(5);
    expect(text('plain-markers.txt').split('\n')[r.findings[3]!.rawLine - 1]).toContain('Remote Desktop');
  });

  it('generic parser groups by severity when present', () => {
    const r = parseLeadsReport(text('sectioned.txt'));
    expect(r.parser).toBe('generic');
    const bySev = groupBySeverity(r.findings);
    expect(bySev.map((g) => g.severity)).toEqual(['critical', 'high', 'medium', 'low', 'info', 'unspecified']);
    expect(bySev.find((g) => g.severity === 'critical')!.findings.map((f) => f.title)).toEqual(['Blank password set for local account']);
    expect(bySev.find((g) => g.severity === 'high')!.findings).toHaveLength(2);
    // "severity: medium" form, and a finding with no severity at all.
    const ftp = r.findings.find((f) => f.title.includes('FTP'))!;
    expect(ftp).toMatchObject({ status: 'fail', severity: 'medium', title: 'FTP service is running' });
    const spooler = r.findings.find((f) => f.title.includes('Print Spooler'))!;
    expect(spooler.severity).toBeUndefined();
    expect(groupBySeverity(r.findings).at(-1)!.severity).toBe('unspecified');
  });

  it('takes the category from the preceding header line', () => {
    const r = parseLeadsReport(text('sectioned.txt'));
    const cat = (needle: string) => r.findings.find((f) => f.title.includes(needle))!.category;
    expect(cat('Guest account')).toBe('Accounts');
    expect(cat('Telnet')).toBe('Firewall');
    expect(cat('FTP')).toBe('Services');
    // Statuses: WARN is not a pass; OK is.
    expect(r.findings.find((f) => f.title.includes('dropped packets'))!.status).toBe('unknown');
    expect(r.findings.find((f) => f.title.includes('Print Spooler'))!.status).toBe('pass');
    expect(r.score).toBe(84);
  });

  it('a line naming more than one status is unknown, not a guess', () => {
    const r = parseLeadsReport('Check X: FAIL (expected PASS)');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.status).toBe('unknown');
  });

  it('does not treat lowercase prose words as markers', () => {
    expect(parseLeadsReport('Everything is ok and nothing failed or passed.').findings).toEqual([]);
  });

  it('keeps parser "generic" with a score but no findings', () => {
    expect(parseLeadsReport('Final result\nScore: 71')).toEqual({ parser: 'generic', score: 71, scoreMax: null, findings: [] });
  });

  it('caps findings and truncates long titles', () => {
    const lines = Array.from({ length: MAX_FINDINGS + 50 }, (_, i) => `[-] finding ${i}`);
    const r = parseLeadsReport(lines.join('\n'));
    expect(r.findings).toHaveLength(MAX_FINDINGS);
    expect(r.truncated).toBe(true);
    const long = parseLeadsReport(`[+] ${'a'.repeat(5000)}`);
    expect(long.findings[0]!.title.length).toBeLessThanOrEqual(300);
  });

  it('parses a JSON array of finding-like objects (documented best effort)', () => {
    const { text: raw } = reportTextFromBytes(bytes('findings.json'), 'findings.json');
    const r = parseLeadsReport(raw);
    expect(r.parser).toBe('json');
    expect(r.findings.map((f) => [f.title, f.status, f.severity, f.category])).toEqual([
      ['Guest account disabled', 'pass', 'low', 'Accounts'],
      ['Remote Desktop enabled', 'fail', 'high', 'Remote Access'],
      ['Audit policy not configured', 'unknown', 'medium', undefined],
    ]);
    // rawLine points into the pretty-printed raw text.
    const lines = raw.split('\n');
    expect(lines[r.findings[1]!.rawLine - 1]).toBe('  {');
    expect(lines[r.findings[1]!.rawLine]).toContain('Remote Desktop enabled');
  });

  it('JSON that does not look like findings stays raw', () => {
    expect(parseLeadsReport('{"hello": "world", "n": [1, 2, 3]}')).toEqual({ parser: 'raw', score: null, findings: [] });
  });

  it('parses JSON wrapped in an object with a score', () => {
    const r = parseLeadsReport(JSON.stringify({ score: 55, findings: [{ name: 'A', passed: false }, { name: 'B', passed: true }] }, null, 2));
    expect(r).toMatchObject({ parser: 'json', score: 55 });
    expect(r.findings.map((f) => [f.title, f.status])).toEqual([['A', 'fail'], ['B', 'pass']]);
  });

  it('parses a header-aware CSV including quoted commas', () => {
    const r = parseLeadsReport(text('findings.csv'));
    expect(r.parser).toBe('csv');
    expect(r.findings.map((f) => [f.title, f.status, f.severity, f.category, f.rawLine])).toEqual([
      ['Guest account disabled', 'pass', 'low', 'Accounts', 2],
      ['Remote Desktop, enabled', 'fail', 'high', 'Remote Access', 3],
      ['Audit policy', 'unknown', 'medium', 'Policy', 4],
    ]);
  });

  it('CSV without recognisable columns falls through to line heuristics', () => {
    expect(parseLeadsReport('a,b,c\n1,2,3').parser).toBe('raw');
  });
});

describe('extractScore', () => {
  it('extracts score from "84/100 points"', () => {
    expect(extractScore('Final: 84/100 points')).toEqual({ score: 84, scoreMax: 100 });
    expect(extractScore('You scored 84 / 100 points!')).toEqual({ score: 84, scoreMax: 100 });
  });
  it('handles "Score: 84", "84 out of 100" and decimals; none when absent', () => {
    expect(extractScore('Score: 84')).toEqual({ score: 84, scoreMax: null });
    expect(extractScore('84 out of 100')).toEqual({ score: 84, scoreMax: 100 });
    expect(extractScore('score = 91.5/100')).toEqual({ score: 91.5, scoreMax: 100 });
    expect(extractScore('nothing to see')).toBeNull();
  });
  it('uses the last score in the report', () => {
    expect(extractScore('Section: 10/10 points\nTotal: 84/100 points')).toEqual({ score: 84, scoreMax: 100 });
  });
});

describe('report text preparation', () => {
  it('htmlToText drops script/style/comments and decodes entities; output is plain text', () => {
    const t = htmlToText(text('report.html'));
    expect(t).not.toMatch(/pwned|alert|color: red/);
    expect(t).toContain('Remote Desktop & Assistance is enabled');
    expect(t).not.toMatch(/<\/?(p|td|table|script)/i);
    expect(t).toContain('[+]');
  });

  it('htmlToText keeps escaped markup as literal text and survives hostile input', () => {
    expect(htmlToText('<p>&lt;script&gt;x&lt;/script&gt;</p>')).toBe('<script>x</script>');
    expect(() => htmlToText('<'.repeat(100000) + '<script>' + '<!--'.repeat(1000))).not.toThrow();
    expect(htmlToText('a < b and c > d')).toBe('a < b and c > d');
  });

  it('parses an HTML report via its converted text', () => {
    const { text: raw } = reportTextFromBytes(bytes('report.html'), 'report.html');
    const r = parseLeadsReport(raw);
    expect(r.parser).toBe('generic');
    expect(r.score).toBe(67);
    expect(r.findings.map((f) => f.status)).toEqual(['pass', 'fail', 'pass']);
    expect(r.findings[1]!.title).toBe('Remote Desktop & Assistance is enabled');
  });

  it('pretty-prints JSON and strips NUL bytes from text', () => {
    expect(reportTextFromBytes(new TextEncoder().encode('[{"a":1}]'), 'x.json').text).toBe('[\n  {\n    "a": 1\n  }\n]');
    expect(reportTextFromBytes(new TextEncoder().encode('{bad json'), 'x.json').text).toBe('{bad json');
    expect(reportTextFromBytes(new TextEncoder().encode('line one\u0000\nline two'), 'x.log').text).toBe('line one\nline two');
  });
});
