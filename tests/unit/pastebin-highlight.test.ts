import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearHighlightCache,
  escapeHtml,
  HIGHLIGHT_DEADLINE_MS,
  highlightPaste,
  MAX_HIGHLIGHT_CHARS,
  renderHighlight,
} from '@/features/pastebin/highlight';
import { extensionFor } from '@/features/pastebin/schema';

const HOSTILE = [
  '<script>alert(1)</script>',
  '</pre><img src=x onerror=alert(1)>',
  `"'><svg onload=alert(1)>`,
  '</code></pre></div><iframe src="javascript:alert(1)">',
];

function expectInert(html: string) {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<img/i);
  expect(html).not.toMatch(/<svg/i);
  expect(html).not.toMatch(/<iframe/i);
  expect(html).not.toMatch(/<[^>]+\son(error|load)=/i);
  // the angle brackets survive only as entities
  expect(html).toContain('&#x3C;');
  // exactly one pre, and it is the outer element
  expect(html.match(/<pre/g)).toHaveLength(1);
  expect(html.match(/<\/pre>/g)).toHaveLength(1);
  expect(html.startsWith('<pre')).toBe(true);
  expect(html.endsWith('</pre>')).toBe(true);
}

beforeEach(() => clearHighlightCache());

describe('renderHighlight', () => {
  for (const language of ['powershell', 'bash', 'batch', 'text', 'markdown'] as const) {
    it(`keeps hostile text inert for ${language}`, async () => {
      const r = await renderHighlight(HOSTILE.join('\n'), language);
      expect(r.fallback).toBeNull();
      expectInert(r.html);
    });
  }

  it('highlights known tokens with spans', async () => {
    const r = await renderHighlight('Get-ChildItem -Path C:\\ # hi', 'powershell');
    expect(r.fallback).toBeNull();
    expect(r.html).toContain('<span');
  });

  it('carries the grammar state across tokenizing steps (a multi-line here-string stays a string)', async () => {
    const code = ['$x = @"', ...Array.from({ length: 40 }, (_, i) => `line ${i} Get-ChildItem`), '"@', 'Get-Service'].join('\n');
    const r = await renderHighlight(code, 'powershell');
    expect(r.fallback).toBeNull();
    // Line 30 is inside the here-string: string-coloured, not a command.
    expect(r.html).toContain('<span style="color:#D9B55B">line 30 Get-ChildItem</span>');
  });

  it('beyond the size cap (64 K characters) falls back to escaped plain text', async () => {
    expect(MAX_HIGHLIGHT_CHARS).toBe(64_000);
    const code = `${HOSTILE.join('\n')}\n${'a'.repeat(MAX_HIGHLIGHT_CHARS)}`;
    const r = await renderHighlight(code, 'bash');
    expect(r.fallback).toBe('too_large');
    expectInert(r.html);
    expect(r.html).toContain(escapeHtml(HOSTILE[1]));
    expect(r.html).not.toContain('<span');
  });

  it('past the total deadline falls back to escaped plain text', async () => {
    let t = 0;
    const now = () => (t += 100); // every check advances the clock by 100 ms
    const code = [...HOSTILE, ...Array.from({ length: 200 }, (_, i) => `echo ${i}`)].join('\n');
    const r = await renderHighlight(code, 'bash', { deadlineMs: 250, now });
    expect(r.fallback).toBe('timeout');
    expectInert(r.html);
    expect(r.html).toContain('echo 199');
  });

  it('bounds the total time of a hostile many-line paste', async () => {
    // Many long, punctuation-heavy lines: each within the per-line limits, a lot in total.
    const line = `${'"$(${x}\\\'`'.repeat(300)}`;
    const code = Array.from({ length: Math.floor(MAX_HIGHLIGHT_CHARS / (line.length + 1)) }, () => line).join('\n');
    const t = performance.now();
    const r = await renderHighlight(code, 'powershell');
    expect(performance.now() - t).toBeLessThan(HIGHLIGHT_DEADLINE_MS + 1500);
    expect(r.html.startsWith('<pre')).toBe(true);
  });

  it('does not freeze on a 50,000 character line', async () => {
    const t = Date.now();
    const r = await renderHighlight('x'.repeat(50_000), 'bash');
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r.html.startsWith('<pre')).toBe(true);
  });
});

describe('highlightPaste cache', () => {
  const paste = { slug: 'abc123', updated_at: new Date('2026-11-15T10:00:00Z'), content: 'Get-Service', language: 'powershell' as const };

  it('a second view of the same paste does not re-tokenize', async () => {
    const render = vi.fn(renderHighlight);
    const a = await highlightPaste(paste, render);
    const b = await highlightPaste(paste, render);
    expect(render).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it('an edit (new updated_at or content) is highlighted afresh', async () => {
    const render = vi.fn(renderHighlight);
    await highlightPaste(paste, render);
    await highlightPaste({ ...paste, updated_at: new Date('2026-11-15T10:05:00Z') }, render);
    await highlightPaste({ ...paste, content: 'Stop-Service' }, render);
    await highlightPaste({ ...paste, language: 'bash' }, render);
    expect(render).toHaveBeenCalledTimes(4);
  });

  it('highlighter errors are not cached', async () => {
    const render = vi.fn(async () => ({ html: '<pre></pre>', fallback: 'error' as const }));
    await highlightPaste(paste, render);
    await highlightPaste(paste, render);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('stays bounded: old entries are evicted', async () => {
    const big = 'x'.repeat(60_000);
    const render = vi.fn(async (code: string) => ({ html: `<pre>${code}</pre>`, fallback: null }));
    for (let i = 0; i < 100; i++) await highlightPaste({ ...paste, slug: `s${i}`, content: big }, render);
    expect(render).toHaveBeenCalledTimes(100);
    await highlightPaste({ ...paste, slug: 's99', content: big }, render); // recent: cached
    expect(render).toHaveBeenCalledTimes(100);
    await highlightPaste({ ...paste, slug: 's0', content: big }, render); // oldest: evicted
    expect(render).toHaveBeenCalledTimes(101);
  });
});

describe('extensionFor', () => {
  it('maps languages to download extensions', () => {
    expect(extensionFor('powershell')).toBe('ps1');
    expect(extensionFor('bash')).toBe('sh');
    expect(extensionFor('batch')).toBe('bat');
    expect(extensionFor('text')).toBe('txt');
    expect(extensionFor('markdown')).toBe('md');
  });
});
