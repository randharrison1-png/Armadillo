import 'server-only';
import { createServerClient, type CookieOptionsWithName } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import type { AuthUser } from './types';

/**
 * Production auth provider: Supabase Auth through @supabase/ssr cookies.
 * Identity always comes from supabase.auth.getUser(), which validates the access token with the
 * Auth server. getSession() only decodes the cookie and is never trusted for identity.
 */

function supabaseConfig(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set (or ARMADILLO_TEST_AUTH=1 in tests).');
  }
  return { url, anonKey };
}

/**
 * Options merged into every Supabase auth cookie. @supabase/ssr defaults to httpOnly: false (for
 * browser clients) and no Secure flag; this app has no browser Supabase client, so the tokens are
 * kept away from page JavaScript and sent only over HTTPS in production builds.
 */
export function supabaseCookieOptions(): CookieOptionsWithName {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

/** Per-request server client for Server Components, Server Actions and Route Handlers. */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const { url, anonKey } = supabaseConfig();
  const store = await cookies();
  return createServerClient(url, anonKey, {
    cookieOptions: supabaseCookieOptions(),
    cookies: {
      getAll: () => store.getAll(),
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; the proxy refreshes the session instead.
        }
      },
    },
  });
}

function toAuthUser(user: { id: string; email?: string | null } | null | undefined): AuthUser | null {
  return user ? { id: user.id, email: user.email ?? '' } : null;
}

export async function supabaseGetCurrentUser(): Promise<AuthUser | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return toAuthUser(data.user);
}

/**
 * Proxy (middleware) helper per the @supabase/ssr Next.js guide: refreshes the session, writes
 * rotated cookies onto the response, and returns the validated user.
 */
export async function updateSupabaseSession(request: NextRequest): Promise<{ response: NextResponse; user: AuthUser | null }> {
  const { url, anonKey } = supabaseConfig();
  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anonKey, {
    cookieOptions: supabaseCookieOptions(),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(toSet, headers) {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });
  // Nothing may run between createServerClient and getUser (see @supabase/ssr docs).
  const { data } = await supabase.auth.getUser();
  return { response, user: toAuthUser(data.user) };
}
