import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import armadillo from './eslint-rules/armadillo.mjs';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { armadillo },
    rules: { 'armadillo/spacing-scale': 'error' },
  },
  globalIgnores(['.next/**', 'out/**', 'node_modules/**', '.tmp/**', 'next-env.d.ts', 'playwright-report/**', 'test-results/**']),
]);
