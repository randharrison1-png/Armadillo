import type { EmailOtpType } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { authMode } from '@/server/auth';
import { createSupabaseServerClient } from '@/server/auth/supabase';

/**
 * Supabase email-confirmation landing (sign-up link). Accepts either the PKCE `code` or the
 * `token_hash` + `type` form of the link, establishes the session cookie, then goes to /app.
 * Always redirects to a fixed same-origin path (no caller-controlled `next`).
 */
export async function GET(request: NextRequest) {
  if (authMode() !== 'supabase') return new NextResponse(null, { status: 404 });

  const { searchParams } = request.nextUrl;
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const supabase = await createSupabaseServerClient();

  let ok = false;
  if (code) {
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  } else if (tokenHash && type) {
    ok = !(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
  }
  const target = request.nextUrl.clone();
  target.pathname = ok ? '/app' : '/login';
  target.search = ok ? '' : '?error=confirm';
  return NextResponse.redirect(target);
}
