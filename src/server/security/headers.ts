/**
 * Security header values, kept free of Next imports and `server-only` so next.config.ts can use
 * them at build time and tests can check them directly.
 *
 * Static headers come from next.config.ts. The Content-Security-Policy needs a per-request nonce,
 * so src/proxy.ts sets it (Next reads the nonce from the request's CSP header and stamps it on its
 * own inline scripts, which is why every page must render dynamically).
 */

export type HeaderEntry = { key: string; value: string };

const YEAR_2 = 63_072_000;

export function staticSecurityHeaders(opts: { production: boolean }): HeaderEntry[] {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'same-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    { key: 'X-Frame-Options', value: 'DENY' },
    // HSTS is ignored over plain http; includeSubDomains is only appropriate on the real deployment.
    { key: 'Strict-Transport-Security', value: `max-age=${YEAR_2}${opts.production ? '; includeSubDomains' : ''}` },
  ];
}

/** The raw paste route serves user text; nothing in it may load, run, or frame. */
export const RAW_PASTE_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'";

/** `/p/<slug>/raw`: the route sets RAW_PASTE_CSP itself, so the proxy leaves it alone. */
export const isRawPastePath = (pathname: string) => /^\/p\/[^/]+\/raw\/?$/.test(pathname);

/** A fresh, unguessable value per request (Next's documented nonce recipe). */
export function newNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString('base64');
}

/**
 * Origins a browser may reach besides this one. The only direct browser-to-third-party traffic is
 * the signed upload of files over 4 MB to Supabase Storage (src/lib/files/uploadClient.ts), so the
 * Supabase project URL (https, and wss for realtime) is allowed and nothing else. Anything that is
 * not a plain https origin is ignored rather than trusted into the policy; plain http is accepted
 * for localhost in development only (a local Supabase stack).
 */
export function supabaseConnectSources(url: string | undefined, dev: boolean): string[] {
  if (!url) return [];
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(u.host)) return [];
  if (u.protocol === 'https:') return [`https://${u.host}`, `wss://${u.host}`];
  if (dev && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return [`http://${u.host}`, `ws://${u.host}`];
  return [];
}

export function buildCsp(opts: { nonce: string; dev: boolean; supabaseUrl?: string }): string {
  const { nonce, dev } = opts;
  return [
    "default-src 'self'",
    // 'strict-dynamic' lets the nonce'd Next bootstrap load its chunks; 'unsafe-eval' is for React's
    // dev-only debugging and is never sent in production.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // Radix, Monaco and Shiki emit inline style attributes/elements, which a nonce cannot cover.
    "style-src 'self' 'unsafe-inline'",
    // Monaco's editor worker is a same-origin module worker (blob: for safety across bundlers).
    "worker-src 'self' blob:",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    ['connect-src', "'self'", ...supabaseConnectSources(opts.supabaseUrl, dev)].join(' '),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
