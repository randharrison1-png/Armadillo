import type { TextEncoding } from '@/lib/types';

export type DecodedText = {
  text: string;
  encoding: TextEncoding;
  lineEnding: 'crlf' | 'lf' | 'mixed';
  /**
   * Set only when the bytes were neither BOM-marked nor valid UTF-8 nor BOM-less UTF-16, so they
   * were decoded as windows-1252 (every byte maps to a character; some are lossy re-encoded as
   * UTF-8). `encoding` is then reported as 'utf-8' because TextEncoding has no single-byte value.
   */
  fallback?: 'windows-1252';
};

/** 'crlf' / 'lf' when every newline is that kind (or there are none: 'lf'); otherwise 'mixed'. */
export function lineEndingOf(text: string): 'crlf' | 'lf' | 'mixed' {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  const kinds = (crlf ? 1 : 0) + (lf ? 1 : 0) + (cr ? 1 : 0);
  if (kinds === 0) return 'lf'; // no newlines
  if (kinds > 1 || cr) return 'mixed'; // lone CR (classic Mac) is reported as mixed
  return crlf ? 'crlf' : 'lf';
}

/** True when every byte at `parity` (0 = even offsets, 1 = odd) is zero, over at least 2 bytes. */
function zeroAtParity(b: Uint8Array, parity: 0 | 1): boolean {
  if (b.length < 2) return false;
  let sawNonZeroOther = false;
  for (let i = 0; i < b.length; i++) {
    if (i % 2 === parity) {
      if (b[i] !== 0) return false;
    } else if (b[i] !== 0) sawNonZeroOther = true;
  }
  return sawNonZeroOther;
}

/**
 * Detects the encoding and decodes. Order: UTF-8 BOM, UTF-16LE BOM (FF FE), UTF-16BE BOM (FE FF);
 * then BOM-less UTF-16 when every other byte is 0 (odd offsets = LE, even offsets = BE); then
 * strict UTF-8; otherwise windows-1252 (see DecodedText.fallback). The BOM is removed
 * from `text`; `encoding` records it so a re-save can restore it.
 */
export function decodeText(bytes: Uint8Array): DecodedText {
  const done = (text: string, encoding: TextEncoding, fallback?: 'windows-1252'): DecodedText => ({
    text,
    encoding,
    lineEnding: lineEndingOf(text),
    ...(fallback ? { fallback } : {}),
  });

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return done(new TextDecoder('utf-8').decode(bytes.subarray(3)), 'utf-8-bom');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return done(new TextDecoder('utf-16le').decode(bytes.subarray(2)), 'utf-16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return done(new TextDecoder('utf-16be').decode(bytes.subarray(2)), 'utf-16be');
  }
  // BOM-less UTF-16 of mostly-ASCII text is also *valid* UTF-8 (NUL bytes), so test it first.
  if (zeroAtParity(bytes, 1)) return done(new TextDecoder('utf-16le').decode(bytes), 'utf-16le');
  if (zeroAtParity(bytes, 0)) return done(new TextDecoder('utf-16be').decode(bytes), 'utf-16be');
  try {
    return done(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'utf-8');
  } catch {
    // not valid UTF-8; fall through
  }
  return done(new TextDecoder('windows-1252').decode(bytes), 'utf-8', 'windows-1252');
}
