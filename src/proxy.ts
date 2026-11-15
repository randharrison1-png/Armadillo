import { NextResponse, type NextRequest } from 'next/server';
import { authMode } from '@/server/auth';
import { updateSupabaseSession } from '@/server/auth/supabase';
import { assertTestAuthAllowed, TEST_AUTH_COOKIE, verifyTestSession } from '@/server/auth/testAuth';
import { buildCsp, isRawPastePath, newNonce } from '@/server/security/headers';

const CSP = 'Content-Security-Policy';

/**
 * Next 16 Proxy (formerly middleware.ts; Node.js runtime). Optimistic guard for /app/*:
 * redirects to /login when there is no valid session. It is not the only gate: every page and
 * action under /app calls requireUser(), which re-verifies the session.
 *
 * Test mode verifies the HMAC cookie fully (signature + expiry), so a forged cookie never
 * reaches the app. Supabase mode refreshes the session cookies on every request, per @supabase/ssr.
 *
 * It also sets the Content-Security-Policy with a fresh nonce per request: on the request (Next
 * reads the nonce from it and stamps its inline scripts) and on the response. The raw paste route
 * sets its own stricter policy, so it is left alone here.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApp = pathname === '/app' || pathname.startsWith('/app/');

  const csp = isRawPastePath(pathname)
    ? null
    : buildCsp({ nonce: newNonce(), dev: process.env.NODE_ENV === 'development', supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL });
  // Set before any NextResponse.next({ request }) below so the app sees it.
  if (csp) request.headers.set(CSP, csp);
  const withCsp = (response: NextResponse): NextResponse => {
    if (csp) response.headers.set(CSP, csp);
    return response;
  };

  if (authMode() === 'test') {
    if (!isApp) return withCsp(NextResponse.next({ request }));
    const user = verifyTestSession(request.cookies.get(TEST_AUTH_COOKIE)?.value, assertTestAuthAllowed());
    return user ? withCsp(NextResponse.next({ request })) : redirectToLogin(request);
  }

  const { response, user } = await updateSupabaseSession(request);
  if (isApp && !user) {
    const redirect = redirectToLogin(request);
    // Keep any cookies Supabase rotated or cleared while checking.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }
  return withCsp(response);
}

function redirectToLogin(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except static assets and image optimization.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)'],
};
