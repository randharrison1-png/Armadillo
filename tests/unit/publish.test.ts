import { describe, expect, it } from 'vitest';
import { publishPasteSchema, updatePasteSchema, CONTENT_MAX_BYTES } from '@/features/pastebin/schema';
import { retryMessage } from '@/features/pastebin/format';

const valid = {
  title: 'T',
  content: 'echo hi',
  language: 'bash' as const,
  visibility: 'public' as const,
  expiresIn: null,
  fromPrivate: false,
  acknowledgeSecrets: false,
  confirmPrivateSource: false,
};

describe('publishPasteSchema', () => {
  it('accepts a valid input and trims the title', () => {
    expect(publishPasteSchema.parse({ ...valid, title: '  Harden SSH  ' }).title).toBe('Harden SSH');
  });
  it('title 1-200 characters after trimming', () => {
    expect(publishPasteSchema.safeParse({ ...valid, title: '   ' }).success).toBe(false);
    expect(publishPasteSchema.safeParse({ ...valid, title: 'x'.repeat(200) }).success).toBe(true);
    expect(publishPasteSchema.safeParse({ ...valid, title: 'x'.repeat(201) }).success).toBe(false);
  });
  it('content is 1 byte to 512 KB (bytes, not characters)', () => {
    expect(publishPasteSchema.safeParse({ ...valid, content: 'a' }).success).toBe(true);
    expect(publishPasteSchema.safeParse({ ...valid, content: '' }).success).toBe(false);
    expect(publishPasteSchema.safeParse({ ...valid, content: 'a'.repeat(CONTENT_MAX_BYTES) }).success).toBe(true);
    expect(publishPasteSchema.safeParse({ ...valid, content: 'a'.repeat(CONTENT_MAX_BYTES + 1) }).success).toBe(false);
    expect(publishPasteSchema.safeParse({ ...valid, content: 'é'.repeat(CONTENT_MAX_BYTES / 2 + 1) }).success).toBe(false);
  });
  it('enums and required flags', () => {
    for (const expiresIn of ['1h', '1d', '7d', '30d', null]) expect(publishPasteSchema.safeParse({ ...valid, expiresIn }).success).toBe(true);
    expect(publishPasteSchema.safeParse({ ...valid, expiresIn: '1y' }).success).toBe(false);
    expect(publishPasteSchema.safeParse({ ...valid, visibility: 'private' }).success).toBe(false);
    expect(publishPasteSchema.safeParse({ ...valid, language: 'cobol' }).success).toBe(false);
    // flags have no default: a caller must say so explicitly
    const { fromPrivate: _f, ...noFlag } = valid;
    void _f;
    expect(publishPasteSchema.safeParse(noFlag).success).toBe(false);
  });
  it('the update schema carries the fingerprint', () => {
    expect(updatePasteSchema.parse({ slug: 'abcdefghij', acknowledgeSecrets: true, secretsFingerprint: 'a'.repeat(64) }).secretsFingerprint).toHaveLength(64);
  });
});

describe('retryMessage', () => {
  it('rounds up to whole minutes', () => {
    expect(retryMessage(1)).toBe('Try again in 1 minute.');
    expect(retryMessage(60)).toBe('Try again in 1 minute.');
    expect(retryMessage(61)).toBe('Try again in 2 minutes.');
    expect(retryMessage(3600)).toBe('Try again in 60 minutes.');
  });
});
