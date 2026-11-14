import 'server-only';
import { createHighlighterCore, type HighlighterCore, type ThemeRegistration } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { ScriptLanguage } from '@/lib/types';

/** Beyond this many characters a paste is shown as a plain escaped <pre>, not highlighted. */
export const MAX_HIGHLIGHT_CHARS = 200_000;

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

/**
 * Server-side highlighting. Returns Shiki's HTML (all token text HTML-escaped by Shiki; the output
 * is the only string that may reach dangerouslySetInnerHTML), or `html: null` when the caller must
 * fall back to a plain escaped <pre> (too large, or the highlighter failed).
 */
export async function highlightCode(code: string, language: ScriptLanguage): Promise<{ html: string | null }> {
  if (code.length > MAX_HIGHLIGHT_CHARS) return { html: null };
  try {
    const h = await getHighlighter();
    const html = h.codeToHtml(code, {
      lang: SHIKI_LANG[language],
      theme: 'armadillo-dark',
      // Lines longer than this are left untokenized (plain), and tokenizing is time-boxed.
      tokenizeMaxLineLength: 10_000,
      tokenizeTimeLimit: 1000,
    } as never);
    return { html };
  } catch {
    return { html: null };
  }
}
