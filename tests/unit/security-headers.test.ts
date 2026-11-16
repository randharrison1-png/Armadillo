// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Supabase mode: the real helper builds its response with NextResponse.next({ request }); mirror that.
const supabase = vi.hoisted(() => ({ user: null as { id: string; email: string } | null }));
vi.mock('@/server/auth/supabase', () => ({
  updateSupabaseSession: async (request: NextRequest) => ({ response: NextResponse.next({ request }), user: supabase.user }),
}));
import { buildCsp, RAW_PASTE_CSP, staticSecurityHeaders } from '@/server/security/headers';
import { proxy } from '@/proxy';

const directive = (csp: string, name: string) =>
  csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));

describe('static security headers (next.config)', () => {
  const get = (production: boolean) => Object.fromEntries(staticSecurityHeaders({ production }).map((h) => [h.key, h.value]));

  it('sets the fixed values', () => {
    const h = get(false);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('same-origin');
    expect(h['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=()');
    expect(h['X-Frame-Options']).toBe('DENY');
  });

  it('adds includeSubDomains to HSTS in production only', () => {
    expect(get(false)['Strict-Transport-Security']).toBe('max-age=63072000');
    expect(get(true)['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains');
  });

  it('never sets CSP statically (it needs a per-request nonce)', () => {
    expect(Object.keys(get(true))).not.toContain('Content-Security-Policy');
  });
});

describe('buildCsp', () => {
  const csp = buildCsp({ nonce: 'abc123', dev: false });

  it('allows scripts only from self and the nonce, with strict-dynamic, and no inline or eval', () => {
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
  });

  it('allows unsafe-eval for scripts in development only', () => {
    expect(directive(buildCsp({ nonce: 'n', dev: true }), 'script-src')).toBe("script-src 'self' 'nonce-n' 'strict-dynamic' 'unsafe-eval'");
  });

  it('has the fixed directives (Monaco worker, Radix/Shiki inline styles, framing, forms)', () => {
    expect(directive(csp, 'default-src')).toBe("default-src 'self'");
    expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
    expect(directive(csp, 'worker-src')).toBe("worker-src 'self' blob:");
    expect(directive(csp, 'img-src')).toBe("img-src 'self' data: blob:");
    expect(directive(csp, 'font-src')).toBe("font-src 'self' data:");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
  });

  it('connect-src is self only without a Supabase URL, and adds its https and wss origins with one', () => {
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
    const withSb = buildCsp({ nonce: 'n', dev: false, supabaseUrl: 'https://abcd.supabase.co/' });
    expect(directive(withSb, 'connect-src')).toBe("connect-src 'self' https://abcd.supabase.co wss://abcd.supabase.co");
  });

  it('ignores a Supabase URL that is not https (never widens connect-src from a bad value)', () => {
    for (const bad of ['', 'not a url', 'http://evil.test', 'javascript:alert(1)', 'https://x.test; script-src *']) {
      expect(directive(buildCsp({ nonce: 'n', dev: false, supabaseUrl: bad }), 'connect-src'), bad).toBe("connect-src 'self'");
    }
  });

  it('allows a plain-http localhost Supabase (local stack) in development only', () => {
    const local = 'http://127.0.0.1:54321';
    expect(directive(buildCsp({ nonce: 'n', dev: true, supabaseUrl: local }), 'connect-src')).toBe("connect-src 'self' http://127.0.0.1:54321 ws://127.0.0.1:54321");
    expect(directive(buildCsp({ nonce: 'n', dev: false, supabaseUrl: local }), 'connect-src')).toBe("connect-src 'self'");
    expect(directive(buildCsp({ nonce: 'n', dev: true, supabaseUrl: 'http://evil.test' }), 'connect-src')).toBe("connect-src 'self'");
  });

  it('the raw-paste CSP is the strict no-load sandbox and still forbids framing', () => {
    expect(RAW_PASTE_CSP).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
  });
});

describe('proxy sets a per-request nonce CSP', () => {
  afterEach(() => vi.unstubAllEnvs());
  const run = (path: string) => {
    vi.stubEnv('ARMADILLO_TEST_AUTH', '1');
    vi.stubEnv('TEST_AUTH_SECRET', 'unit-test-secret-0123456789abcdef-xyz');
    vi.stubEnv('NODE_ENV', 'test');
    return proxy(new NextRequest(`http://localhost${path}`));
  };

  it('puts the CSP on the response and forwards it (with the same nonce) to the app on the request', async () => {
    const res = await run('/p/abc');
    const csp = res.headers.get('content-security-policy')!;
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
    expect(res.headers.get('x-middleware-override-headers')).toContain('content-security-policy');
  });

  it('uses a fresh nonce for every request', async () => {
    const a = (await run('/p/abc')).headers.get('content-security-policy');
    const b = (await run('/p/abc')).headers.get('content-security-policy');
    expect(a).not.toBe(b);
  });

  it('leaves the raw paste route to its own, stricter CSP', async () => {
    const res = await run('/p/abc/raw');
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('does not add a CSP to the redirect for a signed-out visitor', async () => {
    const res = await run('/app/library');
    expect(res.status).toBe(307);
    expect(res.headers.get('content-security-policy')).toBeNull();
  });
});

describe('proxy in Supabase mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    supabase.user = null;
  });
  const run = (path: string) => {
    vi.stubEnv('ARMADILLO_TEST_AUTH', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcd.supabase.co');
    return proxy(new NextRequest(`http://localhost${path}`));
  };

  it('sets the CSP (with the Supabase origins) on the response and the forwarded request', async () => {
    supabase.user = { id: 'u', email: 'a@b.test' };
    const res = await run('/app/library');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toMatch(/'nonce-[^']+'/);
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self' https://abcd.supabase.co wss://abcd.supabase.co");
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
  });

  it('signed-out visitors to /app are redirected without a CSP; public pages still get one', async () => {
    const redirect = await run('/app');
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get('content-security-policy')).toBeNull();
    expect((await run('/p/abc')).headers.get('content-security-policy')).toMatch(/'nonce-/);
  });
});
