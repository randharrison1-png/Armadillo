import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPORT_MAX_BYTES, EXPORT_ZIP_MARGIN_BYTES } from '@/features/settings/schema';
import { MAX_PDF_BYTES, MAX_TEXT_BYTES } from '@/server/files/limits';

const sql = readFileSync('supabase/storage/private-files.sql', 'utf8');
const code = sql.replace(/--.*$/gm, '');
const limit = Number(/false,\s*(\d+)/.exec(code)?.[1]);

describe('private-files bucket config', () => {
  it('parses the bucket config: private, 50 MB', () => {
    expect(code).toMatch(/'private-files',\s*'private-files',\s*false,/);
    expect(limit).toBe(52428800);
  });

  it('sets no MIME allowlist: browser-declared types vary (verifyStoredUpload re-checks extension and size)', () => {
    // A restrictive allowed_mime_types rejected real uploads (e.g. .csv as application/vnd.ms-excel)
    // in production only. The upsert clears any allowlist left from an earlier version.
    expect(code).toMatch(/allowed_mime_types\s*=\s*null/);
    expect(code).not.toMatch(/array\[/);
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
