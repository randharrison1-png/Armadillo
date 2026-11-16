import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '@/lib/contrast';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/input';
import { compile } from 'tailwindcss';

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
    // Theme keeps Tailwind's multiplier so w/h/size utilities work; lint enforces the scale.
    const globals = readFileSync(resolve(root, 'src/app/globals.css'), 'utf8');
    expect(globals).toMatch(/--spacing:\s*4px/);
    expect(globals).not.toMatch(/--spacing-\*:\s*initial/);
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
    expect(await messages('export const a = <div className="gap-x-3" />;')).toHaveLength(1);
    expect(await messages('export const a = <div className="gap-x-4 gap-y-2 space-x-6 md:px-1" />;')).toHaveLength(0);
    expect(await messages('export const a = <div className="p-4 gap-2 mx-auto px-1 py-6 -mt-2" />;')).toHaveLength(0);
  }, 60_000);

  it('sizing utilities are valid with the spacing multiplier', async () => {
    const globals = readFileSync(resolve(root, 'src/app/globals.css'), 'utf8')
      .replace("@import 'tailwindcss';", '@theme { }\n@tailwind utilities;')
      .replace(/@import '\.\.\/styles\/tokens\.css';/, '');
    const { build } = await compile(globals);
    const out = build(['size-3', 'min-w-40', 'max-h-72', 'p-4']);
    expect(out).toMatch(/\.size-3/);
    expect(out).toMatch(/\.min-w-40/);
    expect(out).toMatch(/\.max-h-72/);
  });
});

describe('cn() class merging', () => {
  it('keeps custom font sizes when a color class follows', () => {
    expect(cn('text-small', 'text-text')).toBe('text-small text-text');
    expect(cn('text-h1', 'text-accent-ink')).toContain('text-h1');
    expect(cn(buttonVariants())).toContain('text-small');
    expect(cn(fieldClass, 'h-control')).toContain('text-small');
  });

  it('still lets a later size override an earlier one', () => {
    expect(cn('text-small', 'text-body')).toBe('text-body');
  });
});
