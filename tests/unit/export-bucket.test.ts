import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPORT_CONTENT_TYPE, EXPORT_MAX_BYTES, EXPORT_ZIP_MARGIN_BYTES } from '@/features/settings/schema';
import { MAX_PDF_BYTES, MAX_TEXT_BYTES } from '@/server/files/limits';

const sql = readFileSync('supabase/storage/private-files.sql', 'utf8');
const limit = Number(/false,\s*(\d+)/.exec(sql)?.[1]);
const mimes = [...(/allowed_mime_types[\s\S]*?array\[([\s\S]*?)\]/.exec(sql)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);

describe('private-files bucket vs the account export', () => {
  it('parses the bucket config', () => {
    expect(limit).toBeGreaterThan(0);
    expect(mimes.length).toBeGreaterThan(5);
  });

  it('allows the export zip content type', () => {
    expect(mimes).toContain(EXPORT_CONTENT_TYPE);
  });

  it('the export cap plus its zip-overhead margin fits the bucket file size limit', () => {
    expect(EXPORT_MAX_BYTES + EXPORT_ZIP_MARGIN_BYTES).toBeLessThanOrEqual(limit);
    expect(EXPORT_ZIP_MARGIN_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });

  it('user upload caps are still enforced server-side, below the bucket limit', () => {
    expect(MAX_TEXT_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_PDF_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_PDF_BYTES).toBeLessThanOrEqual(limit);
  });
});
