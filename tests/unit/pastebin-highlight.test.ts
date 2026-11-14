import { describe, expect, it } from 'vitest';
import { highlightCode, MAX_HIGHLIGHT_CHARS } from '@/features/pastebin/highlight';
import { extensionFor } from '@/features/pastebin/schema';

const HOSTILE = [
  '<script>alert(1)</script>',
  '</pre><img src=x onerror=alert(1)>',
  `"'><svg onload=alert(1)>`,
  '</code></pre></div><iframe src="javascript:alert(1)">',
];

describe('highlightCode', () => {
  for (const language of ['powershell', 'bash', 'batch', 'text', 'markdown'] as const) {
    it(`keeps hostile text inert for ${language}`, async () => {
      const r = await highlightCode(HOSTILE.join('\n'), language);
      expect(r.html).not.toBeNull();
      const html = r.html!;
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
    });
  }

  it('highlights known tokens with spans', async () => {
    const r = await highlightCode('Get-ChildItem -Path C:\\ # hi', 'powershell');
    expect(r.html).toContain('<span');
  });

  it('falls back (html null) beyond the size cap', async () => {
    const r = await highlightCode('a'.repeat(MAX_HIGHLIGHT_CHARS + 1), 'bash');
    expect(r.html).toBeNull();
  });

  it('does not freeze on a 50,000 character line', async () => {
    const t = Date.now();
    const r = await highlightCode('x'.repeat(50_000), 'bash');
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r.html === null || r.html.startsWith('<pre')).toBe(true);
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
