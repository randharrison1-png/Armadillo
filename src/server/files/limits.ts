/** Upload limits, per-kind extension allowlists and typed errors. Pure (safe to import anywhere). */

export type UploadKind = 'readme' | 'script' | 'report' | 'evidence';

export const MAX_TEXT_BYTES = 2 * 1024 * 1024; // scripts and text
export const MAX_PDF_BYTES = 25 * 1024 * 1024; // PDFs, reports, evidence
/** Above this, production uploads go straight to Supabase Storage (Vercel body limit is 4.5 MB). */
export const DIRECT_UPLOAD_THRESHOLD_BYTES = 4 * 1024 * 1024;

export const ALLOWED_EXTENSIONS: Record<UploadKind, readonly string[]> = {
  readme: ['.txt', '.md', '.pdf'],
  script: ['.ps1', '.sh', '.bat', '.cmd', '.txt', '.md'], // PDFs are inputs, never scripts
  report: ['.txt', '.log', '.csv', '.json', '.html', '.pdf', '.md'],
  evidence: ['.txt', '.log', '.csv', '.json', '.html', '.pdf', '.md', '.png', '.jpg', '.jpeg'],
};

export class UnsupportedFileTypeError extends Error {
  readonly name = 'UnsupportedFileTypeError';
  constructor(
    readonly filename: string,
    readonly allowed: readonly string[],
  ) {
    super(`Unsupported file type for "${filename}". Allowed: ${allowed.join(' ')}`);
  }
}

export class FileTooLargeError extends Error {
  readonly name = 'FileTooLargeError';
  constructor(
    readonly filename: string,
    readonly size: number,
    readonly limit: number,
  ) {
    super(`"${filename}" is ${size} bytes; the limit for this file type is ${limit} bytes`);
  }
}

export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

/** Size limit for an extension: text and scripts 2 MB; PDFs, reports and evidence 25 MB. */
export function limitFor(ext: string, kind: UploadKind): number {
  if (ext === '.pdf' || kind === 'report' || kind === 'evidence') return MAX_PDF_BYTES;
  return MAX_TEXT_BYTES;
}

export function validateUpload(filename: string, size: number, kind: UploadKind): void {
  const allowed = ALLOWED_EXTENSIONS[kind];
  const ext = extensionOf(filename);
  if (!allowed.includes(ext)) throw new UnsupportedFileTypeError(filename, allowed);
  const limit = limitFor(ext, kind);
  if (size > limit) throw new FileTooLargeError(filename, size, limit);
}

/** The bytes are not a readable document of the claimed type (corrupt, encrypted, hostile, wrong format). */
export class UnreadableDocumentError extends Error {
  readonly name = 'UnreadableDocumentError';
  constructor(
    readonly filename: string,
    readonly reason: string,
  ) {
    super(`Could not read "${filename}": ${reason}`);
  }
}
