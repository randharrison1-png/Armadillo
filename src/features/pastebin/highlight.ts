import 'server-only';
import { createHash } from 'node:crypto';
import { createHighlighterCore, hastToHtml, tokensToHast, type HighlighterCore, type ThemedToken, type ThemeRegistration } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { ScriptLanguage } from '@/lib/types';

/**
 * Beyond this many characters a paste is shown as plain escaped text, not highlighted. The public
 * paste page is anonymous, so highlighting must stay cheap: 64 K characters is plenty for a script.
 */
export const MAX_HIGHLIGHT_CHARS = 64_000;
/** Total tokenizing time for one paste; past it the paste is shown as plain escaped text. */
export const HIGHLIGHT_DEADLINE_MS = 500;
/** Lines tokenized per step; the deadline is checked between steps. */
const LINES_PER_STEP = 16;
/** Per-line time box inside the tokenizer (so one step overshoots the deadline by at most ~16 × this). */
const LINE_TIME_LIMIT_MS = 20;
/** Lines longer than this are left untokenized (plain) by Shiki. */
const MAX_LINE_LENGTH = 10_000;

/** Cached highlighted HTML (per server instance), bounded by its total size. */
export const HIGHLIGHT_CACHE_MAX_BYTES = 8 * 1024 * 1024;

/** Small dark theme on the Armadillo tokens (bg #111713, text #F0F4EF, accent #A8D477). */
export const ARMADILLO_THEME: ThemeRegistration = {
  name: 'armadillo-dark',
  type: 'dark',
  colors: { 'editor.background': '#111713', 'editor.foreground': '#F0F4EF' },
  settings: [
    { settings: { foreground: '#F0F4EF', background: '#111713' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#9AA89D', fontStyle: 'italic' } },
    { scope: ['string', 'string.quoted', 'markup.inline.raw', 'markup.raw'], settings: { foreground: '#D9B55B' } },
    { scope: ['keyword', 'storage', 'keyword.control', 'keyword.operator.logical'], settings: { foreground: '#A8D477' } },
    { scope: ['support.function', 'entity.name.function', 'support.function.powershell', 'entity.name.command'], settings: { foreground: '#8FD3C6' } },
    { scope: ['variable', 'variable.other', 'punctuation.definition.variable'], settings: { foreground: '#C9D8F0' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character.escape'], settings: { foreground: '#E5A77C' } },
    { scope: ['entity.name.tag', 'markup.heading', 'entity.name.section'], settings: { foreground: '#A8D477', fontStyle: 'bold' } },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['invalid'], settings: { foreground: '#E5735C' } },
  ],
};

const THEME = 'armadillo-dark';
const FG = '#F0F4EF';
const BG = '#111713';

const SHIKI_LANG: Record<ScriptLanguage, string> = {
  powershell: 'powershell',
  bash: 'bash',
  batch: 'bat',
  text: 'text',
  markdown: 'markdown',
};

let highlighter: Promise<HighlighterCore> | undefined;

/** Bundled grammars from the npm package; no CDN and no WASM (JS regex engine). */
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [ARMADILLO_THEME],
    langs: [import('shiki/langs/powershell.mjs'), import('shiki/langs/bash.mjs'), import('shiki/langs/bat.mjs'), import('shiki/langs/markdown.mjs')],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

const ESCAPES: Record<string, string> = { '&': '&#x26;', '<': '&#x3C;', '>': '&#x3E;', '"': '&#x22;', "'": '&#x27;' };
/** Escapes every HTML-significant character (text and attribute safe). */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** The plain fallback: the same <pre> shell as Shiki's output, with the code fully escaped. */
function plainHtml(code: string): string {
  return `<pre class="shiki ${THEME} plain" style="background-color:${BG};color:${FG}" tabindex="0"><code>${escapeHtml(code)}</code></pre>`;
}

export type HighlightResult = {
  /** Safe HTML: Shiki's output (token text escaped by Shiki) or the escaped plain fallback. */
  html: string;
  /** null when highlighted; otherwise why the paste is shown as plain text. */
  fallback: null | 'too_large' | 'timeout' | 'error';
};

/** Tokenizes in steps of LINES_PER_STEP lines (carrying the grammar state), checking the deadline in between. */
function tokenize(h: HighlighterCore, code: string, lang: string, deadline: number, now: () => number): ThemedToken[][] | null {
  const lines = code.split(/\r?\n/);
  const out: ThemedToken[][] = [];
  let grammarState: ReturnType<HighlighterCore['getLastGrammarState']> | undefined;
  for (let i = 0; i < lines.length; i += LINES_PER_STEP) {
    if (now() > deadline) return null;
    const step = h.codeToTokensBase(lines.slice(i, i + LINES_PER_STEP).join('\n'), {
      lang,
      theme: THEME,
      grammarState,
      tokenizeMaxLineLength: MAX_LINE_LENGTH,
      tokenizeTimeLimit: LINE_TIME_LIMIT_MS,
    } as never);
    grammarState = h.getLastGrammarState(step);
    out.push(...step);
  }
  return now() > deadline ? null : out;
}

/**
 * Server-side highlighting without caching. Returns safe HTML: Shiki's (all token text HTML-escaped
 * by Shiki), or the escaped plain fallback when the code is over MAX_HIGHLIGHT_CHARS, tokenizing
 * the whole paste would take longer than `deadlineMs` in total, or the highlighter failed.
 */
export async function renderHighlight(
  code: string,
  language: ScriptLanguage,
  opts: { deadlineMs?: number; now?: () => number } = {},
): Promise<HighlightResult> {
  if (code.length > MAX_HIGHLIGHT_CHARS) return { html: plainHtml(code), fallback: 'too_large' };
  const now = opts.now ?? (() => performance.now());
  try {
    const h = await getHighlighter();
    const lang = SHIKI_LANG[language];
    const tokens = tokenize(h, code, lang, now() + (opts.deadlineMs ?? HIGHLIGHT_DEADLINE_MS), now);
    if (!tokens) return { html: plainHtml(code), fallback: 'timeout' };
    const options = { lang, theme: THEME, themeName: THEME, fg: FG, bg: BG };
    const hast = tokensToHast(tokens, options as never, { meta: {}, options, codeToHast: h.codeToHast, codeToTokens: h.codeToTokens, source: code } as never);
    return { html: hastToHtml(hast), fallback: null };
  } catch {
    return { html: plainHtml(code), fallback: 'error' };
  }
}

// ------------------------------------------------------------------------------------------------
// Cache: highlighted HTML by paste (slug + updated_at + language + content hash), LRU by total size
// ------------------------------------------------------------------------------------------------

const cache = new Map<string, { result: HighlightResult; bytes: number }>();
let cacheBytes = 0;

/** Test hook: empties the cache. */
export function clearHighlightCache(): void {
  cache.clear();
  cacheBytes = 0;
}

function remember(key: string, result: HighlightResult) {
  const bytes = result.html.length * 2;
  if (bytes > HIGHLIGHT_CACHE_MAX_BYTES / 4) return; // never let one entry dominate the cache
  cache.set(key, { result, bytes });
  cacheBytes += bytes;
  for (const [k, v] of cache) {
    if (cacheBytes <= HIGHLIGHT_CACHE_MAX_BYTES) break;
    cache.delete(k);
    cacheBytes -= v.bytes;
  }
}

export type PasteForHighlight = { slug: string; updated_at: Date; content: string; language: ScriptLanguage };

/**
 * Highlighting for the public paste page, memoized per server instance. The key includes the
 * paste's updated_at and a hash of its content, so an edit never serves stale HTML. Timeouts are
 * cached too (the same paste would time out again); highlighter errors are not.
 */
export async function highlightPaste(paste: PasteForHighlight, render: typeof renderHighlight = renderHighlight): Promise<HighlightResult> {
  const hash = createHash('sha256').update(paste.content).digest('base64url');
  const key = `${paste.slug}|${paste.updated_at.toISOString()}|${paste.language}|${hash}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // refresh its LRU position
    cache.set(key, hit);
    return hit.result;
  }
  const result = await render(paste.content, paste.language);
  if (result.fallback !== 'error') remember(key, result);
  return result;
}
