import { NextResponse, type NextRequest } from 'next/server';
import { authMode } from '@/server/auth';
import { updateSupabaseSession } from '@/server/auth/supabase';
import { assertTestAuthAllowed, TEST_AUTH_COOKIE, verifyTestSession } from '@/server/auth/testAuth';

/**
 * Next 16 Proxy (formerly middleware.ts; Node.js runtime). Optimistic guard for /app/*:
 * redirects to /login when there is no valid session. It is not the only gate: every page and
 * action under /app calls requireUser(), which re-verifies the session.
 *
 * Test mode verifies the HMAC cookie fully (signature + expiry), so a forged cookie never
 * reaches the app. Supabase mode refreshes the session cookies on every request, per @supabase/ssr.
 */
export async function proxy(request: NextRequest) {
  const isApp = request.nextUrl.pathname === '/app' || request.nextUrl.pathname.startsWith('/app/');

  if (authMode() === 'test') {
    if (!isApp) return NextResponse.next();
    const user = verifyTestSession(request.cookies.get(TEST_AUTH_COOKIE)?.value, assertTestAuthAllowed());
    return user ? NextResponse.next() : redirectToLogin(request);
  }

  const { response, user } = await updateSupabaseSession(request);
  if (isApp && !user) {
    const redirect = redirectToLogin(request);
    // Keep any cookies Supabase rotated or cleared while checking.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }
  return response;
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
