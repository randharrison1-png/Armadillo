/**
 * Windows-1252 ("ANSI" on Western Windows) per the WHATWG Encoding Standard: ASCII as is,
 * 0xA0–0xFF = Latin-1, and 0x80–0x9F mapped below. The five bytes the standard leaves undefined
 * (0x81, 0x8D, 0x8F, 0x90, 0x9D) decode to the C1 control of the same value, so they encode back
 * to themselves: decode → encode reproduces every byte sequence exactly. Client-safe.
 */
const HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
] as const;

const TO_BYTE = new Map<number, number>(HIGH.map((cp, i) => [cp, 0x80 + i]));

/** The byte for one UTF-16 code unit, or -1 when Windows-1252 has no such character. */
function byteFor(code: number): number {
  if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) return code;
  return TO_BYTE.get(code) ?? -1;
}

/** The first character Windows-1252 cannot store, or null when all of `text` fits. */
export function firstNonCp1252(text: string): string | null {
  for (const ch of text) {
    if (ch.length > 1 || byteFor(ch.charCodeAt(0)) < 0) return ch;
  }
  return null;
}

export const cp1252Encodable = (text: string) => firstNonCp1252(text) === null;

/** Encodes `text` as Windows-1252. Throws on a character it cannot store (never substitutes). */
export function encodeCp1252(text: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const b = byteFor(text.charCodeAt(i));
    if (b < 0) throw new RangeError(`Windows-1252 cannot store "${text[i]}" (U+${text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')})`);
    out[i] = b;
  }
  return out;
}
