import { decodeText } from '@/server/files/encoding';
import { extensionOf } from '@/server/files/limits';

/*
 * Turning an uploaded report into the plain text that is stored and shown. No DOM is ever used: an
 * HTML report is converted with a linear tag scanner (script/style/template/svg contents and
 * comments dropped, every other tag removed, entities decoded), and the result is only ever
 * rendered as text.
 */

const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'tr', 'li', 'ul', 'ol', 'table', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'hr', 'blockquote', 'dl', 'dt', 'dd', 'thead', 'tbody', 'tfoot', 'form',
  'fieldset', 'details', 'summary', 'caption', 'body', 'title',
]);
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', times: '×',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,10});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Index just past the `</name ...>` that closes a dropped element, or the end of input. */
function afterClose(html: string, name: string, from: number): number {
  for (let j = html.indexOf('</', from); j !== -1; j = html.indexOf('</', j + 2)) {
    if (html.substr(j + 2, name.length).toLowerCase() === name && !/[A-Za-z0-9]/.test(html[j + 2 + name.length] ?? '')) {
      const end = html.indexOf('>', j);
      return end === -1 ? html.length : end + 1;
    }
  }
  return html.length;
}

/** HTML to plain text. Linear time; never throws; never produces markup that is rendered as HTML. */
export function htmlToText(html: string): string {
  const out: string[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    const c = html[lt + 1] ?? '';
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
    } else if (c === '!' || c === '?') {
      const end = html.indexOf('>', lt + 2);
      i = end === -1 ? n : end + 1;
    } else if (/[A-Za-z/]/.test(c)) {
      const end = html.indexOf('>', lt + 1);
      if (end === -1) {
        // No tag ends anywhere after this point: the rest is text.
        out.push(html.slice(lt));
        break;
      }
      const m = /^(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(html.slice(lt + 1, Math.min(end, lt + 41)));
      i = end + 1;
      if (m) {
        const name = m[2]!.toLowerCase();
        if (DROP_TAGS.has(name) && !m[1] && html[end - 1] !== '/') i = afterClose(html, name, i);
        else if (BLOCK_TAGS.has(name)) out.push('\n');
        else if ((name === 'td' || name === 'th') && m[1]) out.push(' ');
      }
    } else {
      out.push('<');
      i = lt + 1;
    }
  }
  const lines = decodeEntities(out.join(''))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim());
  const squeezed: string[] = [];
  for (const l of lines) if (l !== '' || squeezed.at(-1) !== '') squeezed.push(l);
  return squeezed.join('\n').trim();
}

export type ReportText = { text: string; format: 'text' | 'html' | 'json' };

// NUL cannot be stored in a Postgres text column.
const stripNul = (s: string) => s.replace(/\u0000/g, '');

/**
 * Plain text of a non-PDF report. .html: converted to text. .json: pretty-printed when valid
 * (so line numbers are stable), otherwise as is. Everything else is decoded (encoding detected).
 * NUL characters are removed (they cannot be stored). PDFs go through extractDocument instead.
 */
export function reportTextFromBytes(bytes: Uint8Array, filename: string): ReportText {
  const ext = extensionOf(filename);
  const decoded = decodeText(bytes).text;
  if (ext === '.html') return { text: htmlToText(stripNul(decoded)), format: 'html' };
  if (ext === '.json') {
    try {
      return { text: stripNul(JSON.stringify(JSON.parse(decoded), null, 2)), format: 'json' };
    } catch {
      return { text: stripNul(decoded), format: 'text' };
    }
  }
  return { text: stripNul(decoded), format: 'text' };
}

export { stripNul };
