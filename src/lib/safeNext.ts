/**
 * A post-sign-in destination taken from the URL: only same-site absolute paths ("/p/new") are
 * accepted, so `?next=` can never redirect off-site ("//evil.test", "https://…", "/\evil").
 */
export function safeNext(value: unknown, fallback = '/app'): string {
  if (typeof value !== 'string' || value.length > 200) return fallback;
  if (!/^\/(?![/\\])[^\\\s\u0000-\u001f]*$/.test(value)) return fallback;
  return value;
}
