import { readFileSync } from 'node:fs';

// Single source: allowed steps come from --space-* in tokens.css (4px Tailwind unit => px / 4).
const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
const steps = [...tokens.matchAll(/--space-\d+:\s*(\d+)px;/g)].map((m) => String(Number(m[1]) / 4));
const ALLOWED = new Set(['0', 'px', 'auto', 'reverse', ...steps]);

// Longer alternatives first so gap-x / gap-y / space-x are not swallowed by gap / space.
const PREFIX = /^(gap-x|gap-y|space-x|space-y|px|py|pt|pr|pb|pl|ps|pe|mx|my|mt|mr|mb|ml|ms|me|gap|p|m)-(.+)$/;

/** Returns the offending class names found in a whitespace-separated class string. */
export function findDisallowedSpacing(classString) {
  const bad = [];
  for (const raw of classString.split(/\s+/)) {
    if (!raw) continue;
    const base = raw.slice(raw.lastIndexOf(':') + 1).replace(/^[!-]+/, '');
    const m = PREFIX.exec(base);
    if (!m) continue;
    const value = m[2].replace(/\/\d+$/, '');
    if (!ALLOWED.has(value)) bad.push(raw);
  }
  return bad;
}
