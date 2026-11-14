import { describe, expect, it } from 'vitest';
import { safeNext } from '@/lib/safeNext';

describe('safeNext', () => {
  it('accepts same-site paths', () => {
    expect(safeNext('/p/new')).toBe('/p/new');
    expect(safeNext('/app/library?category=linux')).toBe('/app/library?category=linux');
  });
  it('falls back for anything that could leave the site', () => {
    for (const bad of ['//evil.test', 'https://evil.test', '/\\evil.test', 'p/new', '', undefined, null, 42, '/a b', '/a\nb', `/${'x'.repeat(250)}`]) {
      expect(safeNext(bad), String(bad)).toBe('/app');
    }
    expect(safeNext('//x', '/p')).toBe('/p');
  });
});
