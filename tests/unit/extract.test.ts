// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeText } from '@/server/files/encoding';
import { extractDocument } from '@/server/files/extract';
import { FileTooLargeError, UnsupportedFileTypeError, validateUpload, MAX_TEXT_BYTES } from '@/server/files/limits';

const fx = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), 'tests/fixtures', name)));

describe('decodeText', () => {
  it('decodes UTF-16LE with BOM and reports crlf', () => {
    const r = decodeText(fx('utf16le-crlf.ps1'));
    expect(r.encoding).toBe('utf-16le');
    expect(r.lineEnding).toBe('crlf');
    expect(r.text).toBe("Write-Host 'hello'\r\nGet-Date\r\n");
    expect(r.text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('detects UTF-8 BOM and plain lf', () => {
    expect(decodeText(fx('utf8-bom.ps1'))).toMatchObject({ encoding: 'utf-8-bom', lineEnding: 'crlf', text: "Write-Host 'café'\r\n" });
    expect(decodeText(fx('lf.sh'))).toMatchObject({ encoding: 'utf-8', lineEnding: 'lf' });
  });

  it('decodes UTF-16BE with BOM', () => {
    const r = decodeText(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69, 0x00, 0x0a]));
    expect(r).toMatchObject({ encoding: 'utf-16be', text: 'hi\n', lineEnding: 'lf' });
  });

  it('reports mixed and newline-free line endings', () => {
    expect(decodeText(new TextEncoder().encode('a\r\nb\nc')).lineEnding).toBe('mixed');
    expect(decodeText(new TextEncoder().encode('single line')).lineEnding).toBe('lf');
  });

  it('falls back to BOM-less UTF-16 heuristics, then windows-1252', () => {
    const le = decodeText(new Uint8Array([0x68, 0, 0x69, 0, 0x0a, 0]));
    expect(le).toMatchObject({ encoding: 'utf-16le', text: 'hi\n' });
    const be = decodeText(new Uint8Array([0, 0x68, 0, 0x69]));
    expect(be).toMatchObject({ encoding: 'utf-16be', text: 'hi' });
    const cp = decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9])); // "café" in windows-1252, invalid UTF-8
    expect(cp.text).toBe('café');
    expect(cp.fallback).toBe('windows-1252');
  });
});

describe('extractDocument', () => {
  it('markdown splits into stable paragraph ids', async () => {
    const a = await extractDocument(fx('readme.md'), 'readme.md');
    const b = await extractDocument(fx('readme.md'), 'readme.md');
    expect(a.segments.map((s) => s.text)).toEqual([
      '# Practice Image README',
      'This is a Windows 11 workstation used by a small office.',
      'Authorized users: alice (administrator), bob (standard user).\nRemote Desktop must stay disabled.',
      'Critical services: the print spooler must keep running.',
    ]);
    expect(a.segments.map((s) => s.id)).toEqual(b.segments.map((s) => s.id));
    expect(new Set(a.segments.map((s) => s.id)).size).toBe(4);
    expect(a.segments[1]).toMatchObject({ kind: 'paragraph', index: 1 });
    expect(a.segments[1]!.id).toMatch(/^p-1-[0-9a-f]{8}$/);
    expect(a.hasTextLayer).toBe(true);
  });

  it('pdf yields one segment per page with page index', async () => {
    const r = await extractDocument(fx('readme.pdf'), 'readme.pdf');
    expect(r.segments).toHaveLength(3);
    expect(r.segments.map((s) => [s.id, s.kind, s.index])).toEqual([
      ['page-1', 'page', 1],
      ['page-2', 'page', 2],
      ['page-3', 'page', 3],
    ]);
    expect(r.segments[1]!.text).toContain('alice and bob');
    expect(r.hasTextLayer).toBe(true);
  });

  it('flags PDF with no text layer', async () => {
    const r = await extractDocument(fx('scanned.pdf'), 'scanned.pdf');
    expect(r.hasTextLayer).toBe(false);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.text.trim()).toBe('');
  });

  it('rejects .exe and oversize files with typed errors', async () => {
    await expect(extractDocument(fx('sample.exe'), 'sample.exe')).rejects.toBeInstanceOf(UnsupportedFileTypeError);
    await expect(extractDocument(fx('readme.md'), 'noext')).rejects.toBeInstanceOf(UnsupportedFileTypeError);
    const big = new Uint8Array(MAX_TEXT_BYTES + 1).fill(0x61);
    await expect(extractDocument(big, 'big.txt')).rejects.toBeInstanceOf(FileTooLargeError);
    expect(() => validateUpload('x.exe', 10, 'script')).toThrow(UnsupportedFileTypeError);
    expect(() => validateUpload('x.ps1', MAX_TEXT_BYTES + 1, 'script')).toThrow(FileTooLargeError);
    expect(() => validateUpload('x.pdf', 20 * 1024 * 1024, 'readme')).not.toThrow();
    expect(() => validateUpload('x.pdf', 26 * 1024 * 1024, 'readme')).toThrow(FileTooLargeError);
    expect(() => validateUpload('x.pdf', 10, 'script')).toThrow(UnsupportedFileTypeError); // PDFs are never scripts
    expect(() => validateUpload('x.log', 5 * 1024 * 1024, 'report')).not.toThrow();
    expect(() => validateUpload('shot.png', 10, 'evidence')).not.toThrow();
    expect(() => validateUpload('shot.png', 10, 'report')).toThrow(UnsupportedFileTypeError);
  });
});
