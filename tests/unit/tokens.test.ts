import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '@/lib/contrast';

const root = resolve(__dirname, '../..');
const css = readFileSync(resolve(root, 'src/styles/tokens.css'), 'utf8');

function token(name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`token --${name} missing`);
  return m[1].trim();
}

describe('design tokens', () => {
  it('spec colors are exact', () => {
    expect(token('bg')).toBe('#111713');
    expect(token('surface')).toBe('#1C2520');
    expect(token('accent')).toBe('#A8D477');
    expect(token('text')).toBe('#F0F4EF');
  });

  it('derived tokens match the plan', () => {
    expect(token('surface-raised')).toBe('#232E28');
    expect(token('border')).toBe('#2C3830');
    expect(token('border-input')).toBe('#66776B');
    expect(token('text-muted')).toBe('#9AA89D');
    expect(token('accent-ink')).toBe('#111713');
    expect(token('danger')).toBe('#E5735C');
    expect(token('warning')).toBe('#D9B55B');
    expect(token('radius-sm')).toBe('6px');
    expect(token('radius-md')).toBe('10px');
  });

  it('contrast meets WCAG AA', () => {
    expect(contrastRatio(token('text'), token('surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token('text-muted'), token('surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token('accent-ink'), token('accent'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token('accent'), token('bg'))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(token('border-input'), token('surface'))).toBeGreaterThanOrEqual(3);
  });

  it('spacing scale is 4/8/16/24 only', () => {
    expect([1, 2, 3, 4].map((n) => token(`space-${n}`))).toEqual(['4px', '8px', '16px', '24px']);
    expect(css).not.toMatch(/--space-5/);
    const globals = readFileSync(resolve(root, 'src/app/globals.css'), 'utf8');
    expect(globals).toMatch(/--spacing-\*:\s*initial/);
    for (const k of ['1', '2', '4', '6']) expect(globals).toMatch(new RegExp(`--spacing-${k}:`));
    expect(globals).not.toMatch(/--spacing-(3|5|8|10|12):/);
  });

  it('lint fails on off-scale and arbitrary spacing classes', async () => {
    const eslint = new ESLint({ cwd: root });
    async function messages(code: string) {
      const [r] = await eslint.lintText(code, { filePath: resolve(root, 'src/components/x.tsx') });
      return r.messages.filter((m) => m.ruleId === 'armadillo/spacing-scale');
    }
    expect(await messages('export const a = <div className="p-3" />;')).toHaveLength(1);
    expect(await messages('export const a = <div className="p-[13px]" />;')).toHaveLength(1);
    expect(await messages('export const a = <div className="hover:gap-5 mt-2" />;')).toHaveLength(1);
    expect(await messages('export const a = <div className="p-4 gap-2 mx-auto px-1 py-6 -mt-2" />;')).toHaveLength(0);
  }, 60_000);
});
