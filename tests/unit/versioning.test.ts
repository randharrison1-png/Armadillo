import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeText } from '@/server/files/encoding';
import { contentDisposition, encodeForDownload, normalizeForLineEnding } from '@/features/library/versioning';
import { lineDiffStats } from '@/features/library/lineDiff';
import { cp1252Encodable, firstNonCp1252 } from '@/lib/cp1252';
import {
  diffTab,
  parseDiffResourceId,
  parseScriptResourceId,
  scriptTab,
  versionViewTab,
} from '@/features/library/scriptTabs';
import type { ScriptVersion } from '@/lib/types';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures');
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));

/** A ScriptVersion as the upload path would store it (content/encoding/line ending from decodeText). */
function versionFrom(bytes: Uint8Array): ScriptVersion {
  const d = decodeText(bytes);
  return {
    id: '00000000-0000-4000-8000-000000000001',
    owner_id: '00000000-0000-4000-8000-000000000002',
    created_at: new Date(0),
    script_id: '00000000-0000-4000-8000-000000000003',
    version_no: 1,
    content: d.text,
    encoding: d.encoding,
    line_ending: d.lineEnding,
    language: 'powershell',
    sha256: '0'.repeat(64),
    author: 'user',
    change_note: null,
    base_version_id: null,
  };
}

const v = (content: string, encoding: ScriptVersion['encoding']): ScriptVersion => ({
  ...versionFrom(new Uint8Array()),
  content,
  encoding,
});

describe('encodeForDownload', () => {
  it.each(['utf16le-crlf.ps1', 'utf8-bom.ps1', 'lf.sh', 'cp1252.ps1'])('round-trips %s byte-for-byte (decode -> store -> download)', (name) => {
    const original = fixture(name);
    expect([...encodeForDownload(versionFrom(original))]).toEqual([...original]);
  });

  it('utf-8 has no BOM; utf-8-bom adds EF BB BF', () => {
    expect([...encodeForDownload(v('é', 'utf-8'))]).toEqual([0xc3, 0xa9]);
    expect([...encodeForDownload(v('é', 'utf-8-bom'))]).toEqual([0xef, 0xbb, 0xbf, 0xc3, 0xa9]);
  });

  it('utf-16le / utf-16be write their BOM and code units (surrogate pairs included)', () => {
    expect([...encodeForDownload(v('A\r\n', 'utf-16le'))]).toEqual([0xff, 0xfe, 0x41, 0, 0x0d, 0, 0x0a, 0]);
    expect([...encodeForDownload(v('A\r\n', 'utf-16be'))]).toEqual([0xfe, 0xff, 0, 0x41, 0, 0x0d, 0, 0x0a]);
    expect([...encodeForDownload(v('😀', 'utf-16le'))]).toEqual([0xff, 0xfe, 0x3d, 0xd8, 0x00, 0xde]);
  });

  it('never converts newlines: the stored string already carries its line ending', () => {
    expect([...encodeForDownload(v('a\nb\r\nc\rd', 'utf-8'))]).toEqual([...new TextEncoder().encode('a\nb\r\nc\rd')]);
  });

  it('windows-1252 (ANSI) uploads download byte-identical, including 0x80-0x9F and the 5 undefined bytes', () => {
    const all = new Uint8Array(256).map((_, i) => i).filter((b) => b !== 0); // every byte value
    const v1252 = { ...versionFrom(new Uint8Array()), content: new TextDecoder('windows-1252').decode(all), encoding: 'windows-1252' as const };
    expect([...encodeForDownload(v1252)]).toEqual([...all]);
    expect([...encodeForDownload(v('\u2013€é\r\n', 'windows-1252'))]).toEqual([0x96, 0x80, 0xe9, 0x0d, 0x0a]);
  });

  it('refuses to write characters Windows-1252 cannot hold', () => {
    expect(() => encodeForDownload(v('→', 'windows-1252'))).toThrow(/Windows-1252/);
  });
});

describe('normalizeForLineEnding', () => {
  it('rewrites every newline to the declared ending, and leaves mixed text alone', () => {
    expect(normalizeForLineEnding('a\nb\r\nc\rd', 'crlf')).toBe('a\r\nb\r\nc\r\nd');
    expect(normalizeForLineEnding('a\nb\r\nc\rd', 'lf')).toBe('a\nb\nc\nd');
    expect(normalizeForLineEnding('a\nb\r\n', 'mixed')).toBe('a\nb\r\n');
  });
});

describe('contentDisposition', () => {
  it('is an attachment with an ASCII fallback and an RFC 5987 filename*', () => {
    expect(contentDisposition('harden.ps1')).toBe(`attachment; filename="harden.ps1"; filename*=UTF-8''harden.ps1`);
    expect(contentDisposition('café "x".ps1')).toBe(`attachment; filename="caf_ _x_.ps1"; filename*=UTF-8''caf%C3%A9%20%22x%22.ps1`);
  });

  it('strips header-breaking characters', () => {
    const h = contentDisposition('a\r\nSet-Cookie: x.sh');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h).toContain(`filename="a__Set-Cookie: x.sh"`); // quoted, so ":" is inert
  });
});

describe('script tab descriptors', () => {
  const S = '11111111-1111-4111-8111-111111111111';
  const A = '22222222-2222-4222-8222-222222222222';
  const B = '33333333-3333-4333-8333-333333333333';

  it('editor tab: key script:<id>, resourceId = script id', () => {
    expect(scriptTab(S, 'harden.ps1')).toEqual({ key: `script:${S}`, kind: 'script', title: 'harden.ps1', resourceId: S });
    expect(parseScriptResourceId(S)).toEqual({ scriptId: S, versionId: null });
  });

  it('read-only version tab: resourceId <scriptId>@<versionId>', () => {
    const t = versionViewTab(S, A, 'harden.ps1', 2);
    expect(t).toEqual({ key: `script:${S}@${A}`, kind: 'script', title: 'harden.ps1 v2', resourceId: `${S}@${A}` });
    expect(parseScriptResourceId(t.resourceId!)).toEqual({ scriptId: S, versionId: A });
  });

  it('diff tab: resourceId <scriptId>:<versionA>..<versionB>', () => {
    const t = diffTab(S, { id: A, no: 1 }, { id: B, no: 3 }, 'harden.ps1');
    expect(t).toEqual({ key: `diff:${S}:${A}..${B}`, kind: 'diff', title: 'harden.ps1 v1 ↔ v3', resourceId: `${S}:${A}..${B}` });
    expect(parseDiffResourceId(t.resourceId!)).toEqual({ scriptId: S, fromVersionId: A, toVersionId: B });
  });

  it('rejects malformed resource ids', () => {
    expect(parseScriptResourceId('nope')).toBeNull();
    expect(parseScriptResourceId(`${S}@nope`)).toBeNull();
    expect(parseDiffResourceId(`${S}:${A}`)).toBeNull();
    expect(parseDiffResourceId(`x:${A}..${B}`)).toBeNull();
  });
});

describe('lineDiffStats', () => {
  it('counts added and removed lines, ignoring newline kind', () => {
    expect(lineDiffStats('echo one', 'echo one\necho two\necho three')).toEqual({ added: 2, removed: 0, approximate: false });
    expect(lineDiffStats('a\r\nb\r\nc', 'a\nc')).toEqual({ added: 0, removed: 1, approximate: false });
    expect(lineDiffStats('a\nb\nc', 'a\nB\nc\nd')).toEqual({ added: 2, removed: 1, approximate: false });
    expect(lineDiffStats('same', 'same')).toEqual({ added: 0, removed: 0, approximate: false });
  });

  it('gives up cheaply on huge rewrites', () => {
    const a = Array.from({ length: 500 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 500 }, (_, i) => `b${i}`).join('\n');
    expect(lineDiffStats(a, b, 10)).toEqual({ added: 500, removed: 500, approximate: true });
    expect(lineDiffStats(a, b)).toEqual({ added: 500, removed: 500, approximate: false });
  });
});

describe('cp1252 helpers', () => {
  it('knows which text Windows-1252 can store', () => {
    expect(cp1252Encodable('Remove-Item \u2013Force # café €')).toBe(true);
    expect(cp1252Encodable('arrow → here')).toBe(false);
    expect(firstNonCp1252('arrow → here')).toBe('→');
    expect(firstNonCp1252('fine é')).toBeNull();
  });
});
