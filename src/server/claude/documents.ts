import type { ResourceRef } from '@/lib/types';

/**
 * Rendering of untrusted documents for Claude: wrapping, escaping and the token budget.
 * Pure functions (no I/O) so the injection defenses can be tested exhaustively.
 *
 * Wrapping: every selected resource becomes
 *
 *   <untrusted_document type="readme" id="…" title="…">
 *   …metadata and content…
 *   </untrusted_document>
 *
 * Escaping scheme (content): the sequence `<`, optional whitespace/zero-width characters, optional
 * `/`, optional whitespace, then `untrusted_document` (case-insensitive; this also covers an opening
 * tag and longer names such as `untrusted_documents`) gets its `<` replaced by `&lt;`. Because that
 * would make a literal `&lt;/untrusted_document` in the content look the same as an escaped real tag,
 * an `&` that starts such a literal is first turned into `&amp;`, so the encoding is injective and
 * nothing in the content can recreate a tag: we never decode. All other text (shell redirects,
 * PowerShell `<#`, heredocs) is left byte for byte as it was.
 *
 * Escaping scheme (attributes): `& " < >` are entity-encoded and control characters / newlines become
 * spaces, so a filename cannot leave the opening tag.
 */

export const DOC_TAG = 'untrusted_document';

/** Whitespace as Claude (or a lenient parser) might skip it: \s plus zero-width characters and the BOM. */
const WS = '[\\s\\u00a0\\u200b-\\u200f\\u2060\\ufeff]*';
const TAG_PREFIX = `${WS}\\/?${WS}${DOC_TAG}`;
const TAG_RE = new RegExp(`<(?=${TAG_PREFIX})`, 'gi');
const ENTITY_RE = new RegExp(`&(?=lt;${TAG_PREFIX})`, 'gi');
const MARKER_RE = /^\[seg /gm;

export function escapeUntrusted(text: string): string {
  return text.replace(ENTITY_RE, '&amp;').replace(TAG_RE, '&lt;').replace(MARKER_RE, '\\[seg ');
}

const ATTR_MAX = 200;
export function escapeAttr(value: string): string {
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, ATTR_MAX);
  return flat.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Approximation used for budgeting: 4 characters per token. */
export const tokensOf = (s: string) => Math.ceil(s.length / 4);

export type RenderableDoc = {
  ref: ResourceRef;
  /** Shown in the opening tag. */
  title: string;
  /** Metadata lines, never trimmed (e.g. `filename: x.ps1`). Escaped by renderBlock. */
  head: string;
  /** The content, trimmed from the tail when over budget. */
  body: string;
  /** Put the body in a code fence (scripts). */
  fenced: boolean;
};

/** Reserved for the `[trimmed: N characters omitted]` line, so the budget holds with markers. */
const MARKER_RESERVE = 64;

function fenceFor(body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((m) => m.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * Renders one block. `omitted` > 0 appends the trimmed marker inside the block. The body is raw and
 * escaped here, unless `escapedBody` (already escaped, possibly cut) is given: escaping is not
 * idempotent by design, so escaped text must never be escaped again.
 */
export function renderBlock(doc: RenderableDoc, omitted: number, escapedBody?: string): string {
  const safeBody = escapedBody ?? escapeUntrusted(doc.body);
  const lines = [`<${DOC_TAG} type="${doc.ref.type}" id="${escapeAttr(doc.ref.id)}" title="${escapeAttr(doc.title)}">`];
  if (doc.head) lines.push(escapeUntrusted(doc.head));
  if (doc.fenced) {
    const fence = fenceFor(doc.body);
    lines.push(fence, safeBody, fence);
  } else {
    lines.push(safeBody);
  }
  if (omitted > 0) lines.push(`[trimmed: ${omitted} characters omitted]`);
  lines.push(`</${DOC_TAG}>`);
  return lines.join('\n');
}

/** Cuts `s` to at most `n` UTF-16 units without splitting a surrogate pair. */
function cut(s: string, n: number): string {
  if (n >= s.length) return s;
  if (n <= 0) return '';
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/**
 * Fits the documents into `budgetTokens` (4 characters per token). Fixed parts (tags, metadata, the
 * trimmed marker) are always kept; the bodies share what is left in equal shares, a body smaller
 * than its share giving the rest to the others. Over-budget bodies lose their tail. Escaping can
 * only grow a body, so sizes are measured on the escaped text and trimming is applied to it.
 */
export function allocateBodies(docs: readonly RenderableDoc[], budgetTokens: number): { blocks: string[]; trimmed: ResourceRef[] } {
  const escaped = docs.map((d) => escapeUntrusted(d.body));
  const overhead = docs.map((d) => renderBlock(d, 0, '').length + MARKER_RESERVE + 1);
  const separators = Math.max(0, docs.length - 1) * 2;
  let remaining = Math.max(0, budgetTokens * 4 - overhead.reduce((a, b) => a + b, 0) - separators);

  const allowed = new Array<number>(docs.length).fill(0);
  const order = docs.map((_, i) => i).sort((a, b) => escaped[a].length - escaped[b].length);
  order.forEach((i, k) => {
    const share = Math.floor(remaining / (order.length - k));
    allowed[i] = Math.min(escaped[i].length, share);
    remaining -= allowed[i];
  });

  const trimmed: ResourceRef[] = [];
  const blocks = docs.map((d, i) => {
    if (escaped[i].length <= allowed[i]) return renderBlock(d, 0);
    trimmed.push(d.ref);
    const kept = cut(escaped[i], allowed[i]);
    return renderBlock(d, escaped[i].length - kept.length, kept);
  });
  return { blocks, trimmed };
}
