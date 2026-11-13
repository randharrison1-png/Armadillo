import { createHash } from 'node:crypto';
import type { Segment } from '@/lib/types';
import { decodeText } from './encoding';
import { extensionOf, FileTooLargeError, limitFor, UnreadableDocumentError, UnsupportedFileTypeError, type UploadKind } from './limits';

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

export const MAX_PDF_PAGES = 500;

async function pdfSegments(bytes: Uint8Array, filename: string): Promise<Segment[]> {
  // unpdf bundles pdf.js and runs offline in Node. It may transfer the buffer, so give it a copy.
  const { getDocumentProxy, extractText } = await import('unpdf');
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new UnreadableDocumentError(filename, `PDF has ${pdf.numPages} pages; the limit is ${MAX_PDF_PAGES}`);
    }
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((t, i) => ({ id: `page-${i + 1}`, kind: 'page' as const, index: i + 1, text: t.trim() }));
  } catch (e) {
    if (e instanceof UnreadableDocumentError) throw e;
    // Corrupt, encrypted (password required) or non-PDF bytes surface as raw pdf.js errors.
    throw new UnreadableDocumentError(filename, e instanceof Error ? e.message : 'invalid PDF');
  } finally {
    await pdf?.loadingTask.destroy().catch(() => undefined);
  }
}

/**
 * Text and PDF extraction for README inputs and LEADS reports. Text-like files become paragraph
 * segments; PDFs become one segment per page (1-based `index`). `hasTextLayer` is false when no
 * page has any non-whitespace text (a scan: callers must ask for pasted text instead).
 * `kind` selects the size limit (default 'readme'; pass 'report' for LEADS output, so a 5 MB .log
 * that passed upload validation also extracts). Throws UnsupportedFileTypeError, FileTooLargeError,
 * UnreadableDocumentError (corrupt/encrypted/hostile PDF, > MAX_PDF_PAGES pages).
 */
export async function extractDocument(bytes: Uint8Array, filename: string, kind: UploadKind = 'readme'): Promise<ExtractedDocument> {
  const ext = extensionOf(filename);
  if (!EXTRACTABLE.includes(ext)) throw new UnsupportedFileTypeError(filename, EXTRACTABLE);
  const limit = limitFor(ext, kind);
  if (bytes.byteLength > limit) throw new FileTooLargeError(filename, bytes.byteLength, limit);

  if (ext === '.pdf') {
    const segments = await pdfSegments(bytes, filename);
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
