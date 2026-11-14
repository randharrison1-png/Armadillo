import { randomBytes } from 'node:crypto';
import type { ResourceRef } from '@/lib/types';

/**
 * Rendering of untrusted documents for Claude: wrapping, escaping and the token budget.
 * Pure functions (no I/O) so the injection defenses can be tested exhaustively.
 *
 * Per-request nonce: every request gets a random nonce (80 bits, hex) that content cannot predict.
 * It is part of the tag name and of the segment markers, and the system prompt names it as the only
 * valid form:
 *
 *   <untrusted_document_NONCE type="readme" id="…" title="…">
 *   …metadata and content, README segments as `[seg-NONCE <segment id>]` lines…
 *   </untrusted_document_NONCE>
 *
 * Lookalike closing tags or forged markers in the content (wrong or missing nonce, any case,
 * entities, fullwidth or zero-width characters) therefore carry no meaning. As defense in depth the
 * content is also escaped:
 *  - `<` followed by optional whitespace/zero-width characters, optional `/`, optional whitespace and
 *    `untrusted_document` (case-insensitive; covers the nonce'd tag) becomes `&lt;`;
 *  - the literal `[seg-NONCE` becomes `&#91;seg-NONCE`;
 *  - to keep this injective (distinct contents never encode to the same text, and nothing is ever
 *    decoded), an `&` that begins an entity chain `(&amp;)*` leading to one of those escaped forms
 *    is itself turned into `&amp;`. Without that, the literal text `&lt;/untrusted_document` and an
 *    escaped real tag would coincide.
 * All other text (shell redirects, PowerShell `<#`, heredocs) is left byte for byte as it was.
 *
 * Attributes: `& " < >` are entity-encoded and control characters / newlines become spaces.
 */

export const DOC_TAG = 'untrusted_document';

export function newNonce(): string {
  return randomBytes(10).toString('hex');
}

/** Whitespace as Claude (or a lenient parser) might skip it: \s plus zero-width characters and the BOM. */
const WS = '[\\s\\u00a0\\u200b-\\u200f\\u2060\\ufeff]*';
const TAG_PREFIX = `${WS}\\/?${WS}${DOC_TAG}`;
const TAG_RE = new RegExp(`<(?=${TAG_PREFIX})`, 'gi');

export function escapeUntrusted(text: string, nonce: string): string {
  const marker = `[seg-${nonce}`;
  const entityRe = new RegExp(`&(?=(?:amp;)*(?:lt;${TAG_PREFIX}|#91;${escapeRe(`seg-${nonce}`)}))`, 'gi');
  return text.replace(entityRe, '&amp;').replace(TAG_RE, '&lt;').split(marker).join(`&#91;seg-${nonce}`);
}

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Segment ids cited in `text` with the request's marker form `[seg-NONCE <id>]`, in order, de-duplicated. */
export function extractSegmentIds(text: string, nonce: string): string[] {
  const re = new RegExp(`\\[seg-${escapeRe(nonce)} ([A-Za-z0-9_-]{1,64})\\]`, 'g');
  return [...new Set([...text.matchAll(re)].map((m) => m[1]))];
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
  /** The content, trimmed from the tail when over budget (ignored when `segments` is set). */
  body: string;
  /** README segments: each is escaped on its own and introduced by a real `[seg-NONCE <id>]` marker. */
  segments?: { id: string; text: string }[];
  /** Put the body in a code fence (scripts). */
  fenced: boolean;
};

/** Reserved for the `[trimmed: N characters omitted]` line, so the budget holds with markers. */
const MARKER_RESERVE = 64;

function fenceFor(body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((m) => m.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const segmentId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

/** The escaped body: segment texts escaped one by one and joined with the real (unescaped) markers. */
export function escapedBodyOf(doc: RenderableDoc, nonce: string): string {
  if (!doc.segments) return escapeUntrusted(doc.body, nonce);
  return doc.segments.map((s) => `[seg-${nonce} ${segmentId(s.id)}]\n${escapeUntrusted(s.text, nonce)}`).join('\n\n');
}

/**
 * Renders one block. `omitted` > 0 appends the trimmed marker inside the block. The body is raw and
 * escaped here, unless `escapedBody` (already escaped, possibly cut) is given: escaping is not
 * idempotent by design, so escaped text must never be escaped again.
 */
export function renderBlock(doc: RenderableDoc, omitted: number, nonce: string, escapedBody?: string): string {
  const safeBody = escapedBody ?? escapedBodyOf(doc, nonce);
  const tag = `${DOC_TAG}_${nonce}`;
  const lines = [`<${tag} type="${doc.ref.type}" id="${escapeAttr(doc.ref.id)}" title="${escapeAttr(doc.title)}">`];
  if (doc.head) lines.push(escapeUntrusted(doc.head, nonce));
  if (doc.fenced) {
    const fence = fenceFor(doc.body);
    lines.push(fence, safeBody, fence);
  } else {
    lines.push(safeBody);
  }
  if (omitted > 0) lines.push(`[trimmed: ${omitted} characters omitted]`);
  lines.push(`</${tag}>`);
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
export function allocateBodies(docs: readonly RenderableDoc[], budgetTokens: number, nonce: string): { blocks: string[]; trimmed: ResourceRef[] } {
  const escaped = docs.map((d) => escapedBodyOf(d, nonce));
  const overhead = docs.map((d) => renderBlock(d, 0, nonce, '').length + MARKER_RESERVE + 1);
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
    if (escaped[i].length <= allowed[i]) return renderBlock(d, 0, nonce, escaped[i]);
    trimmed.push(d.ref);
    const kept = cut(escaped[i], allowed[i]);
    return renderBlock(d, escaped[i].length - kept.length, nonce, kept);
  });
  return { blocks, trimmed };
}
