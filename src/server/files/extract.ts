import { createHash } from 'node:crypto';
import type { Segment } from '@/lib/types';
import { decodeText } from './encoding';
import { extensionOf, FileTooLargeError, limitFor, UnsupportedFileTypeError } from './limits';

export type ExtractedDocument = { text: string; segments: Segment[]; hasTextLayer: boolean };

const TEXT_EXTENSIONS = ['.txt', '.md', '.log', '.csv', '.json', '.html', '.ps1', '.sh', '.bat', '.cmd'];
const EXTRACTABLE = [...TEXT_EXTENSIONS, '.pdf'];

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

/** Paragraph = run of lines separated by blank (or whitespace-only) lines. Ids are `p-<index>-<hash>`. */
function paragraphSegments(text: string): Segment[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*(?:\n[ \t]*)+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p, index) => ({ id: `p-${index}-${shortHash(p)}`, kind: 'paragraph' as const, index, text: p }));
}

async function pdfSegments(bytes: Uint8Array): Promise<Segment[]> {
  // unpdf bundles pdf.js and runs offline in Node. It may transfer the buffer, so give it a copy.
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map((t, i) => ({ id: `page-${i + 1}`, kind: 'page' as const, index: i + 1, text: t.trim() }));
}

/**
 * Text and PDF extraction for README inputs and LEADS reports. Text-like files become paragraph
 * segments; PDFs become one segment per page (1-based `index`). `hasTextLayer` is false when no
 * page has any non-whitespace text (a scan: callers must ask for pasted text instead).
 * Throws UnsupportedFileTypeError / FileTooLargeError.
 */
export async function extractDocument(bytes: Uint8Array, filename: string): Promise<ExtractedDocument> {
  const ext = extensionOf(filename);
  if (!EXTRACTABLE.includes(ext)) throw new UnsupportedFileTypeError(filename, EXTRACTABLE);
  const limit = limitFor(ext, 'readme');
  if (bytes.byteLength > limit) throw new FileTooLargeError(filename, bytes.byteLength, limit);

  if (ext === '.pdf') {
    const segments = await pdfSegments(bytes);
    return {
      text: segments.map((s) => s.text).filter(Boolean).join('\n\n'),
      segments,
      hasTextLayer: segments.some((s) => s.text.length > 0),
    };
  }
  const { text } = decodeText(bytes);
  const segments = paragraphSegments(text);
  return { text, segments, hasTextLayer: segments.length > 0 };
}
