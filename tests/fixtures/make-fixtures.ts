/**
 * Deterministically generates the binary/encoded fixtures used by tests/unit/extract.test.ts.
 * Run: pnpm fixtures. Output is byte-stable (fixed PDF metadata, no timestamps), so re-running
 * must produce no git diff.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const dir = dirname(fileURLToPath(import.meta.url));
const out = (name: string, data: Uint8Array | string) => writeFileSync(join(dir, name), data);
mkdirSync(dir, { recursive: true });

// --- text fixtures (raw bytes so encodings are exact) ---
const utf16le = (s: string) => {
  const b = Buffer.alloc(2 + s.length * 2);
  b[0] = 0xff;
  b[1] = 0xfe;
  Buffer.from(s, 'utf16le').copy(b, 2);
  return b;
};
out('utf16le-crlf.ps1', utf16le("Write-Host 'hello'\r\nGet-Date\r\n"));
out('utf8-bom.ps1', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Write-Host 'café'\r\n", 'utf8')]));
out('lf.sh', '#!/bin/bash\necho hardening\nexit 0\n');
out(
  'readme.md',
  [
    '# Practice Image README',
    '',
    'This is a Windows 11 workstation used by a small office.',
    '',
    'Authorized users: alice (administrator), bob (standard user).',
    'Remote Desktop must stay disabled.',
    '',
    '',
    'Critical services: the print spooler must keep running.',
    '',
  ].join('\n'),
);
out('sample.exe', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]));

// --- PDFs ---
function fixedMeta(doc: PDFDocument) {
  const d = new Date('2026-01-01T00:00:00Z');
  doc.setTitle('fixture');
  doc.setProducer('armadillo-fixtures');
  doc.setCreator('armadillo-fixtures');
  doc.setCreationDate(d);
  doc.setModificationDate(d);
}

async function readmePdf() {
  const doc = await PDFDocument.create();
  fixedMeta(doc);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [
    'Page one: scenario overview for the practice image.',
    'Page two: authorized users are alice and bob.',
    'Page three: remote desktop must remain disabled.',
  ];
  for (const text of pages) doc.addPage([612, 792]).drawText(text, { x: 72, y: 700, size: 14, font });
  return doc.save({ useObjectStreams: false });
}

/** 2x2 RGB PNG built by hand so the bytes are stable. */
function tinyPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = (r: number, g: number, b: number) => Buffer.from([0, r, g, b, r, g, b]);
  const raw = Buffer.concat([row(200, 200, 200), row(120, 120, 120)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function scannedPdf() {
  const doc = await PDFDocument.create();
  fixedMeta(doc);
  const img = await doc.embedPng(tinyPng());
  doc.addPage([612, 792]).drawImage(img, { x: 72, y: 400, width: 400, height: 300 });
  return doc.save({ useObjectStreams: false });
}

out('readme.pdf', await readmePdf());
out('scanned.pdf', await scannedPdf());
