// Allowed spacing steps: 4/8/16/24 px => p-1, p-2, p-4, p-6 (plus 0, px, auto).
const PREFIX =
  /^(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)-(.+)$/;
const ALLOWED = new Set(['0', '1', '2', '4', '6', 'px', 'auto', 'reverse']);

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
