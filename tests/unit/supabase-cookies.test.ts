// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Args = [url: string, key: string, options: { cookieOptions?: unknown }];
const createServerClient = vi.fn<(...args: Args) => unknown>(() => ({
  auth: { getUser: async () => ({ data: { user: null }, error: null }) },
}));

vi.mock('@supabase/ssr', () => ({ createServerClient: (...args: Args) => createServerClient(...args) }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}));

const { createSupabaseServerClient, supabaseCookieOptions, updateSupabaseSession } = await import(
  '@/server/auth/supabase'
);

beforeEach(() => {
  createServerClient.mockClear();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function passedCookieOptions(): unknown {
  expect(createServerClient).toHaveBeenCalledTimes(1);
  return createServerClient.mock.calls[0][2].cookieOptions;
}

describe('Supabase auth cookie options', () => {
  it('are httpOnly, SameSite=Lax and Secure when NODE_ENV is production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(supabaseCookieOptions()).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  });

  it('stay httpOnly but drop Secure outside production (plain-http dev)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(supabaseCookieOptions()).toMatchObject({ httpOnly: true, secure: false, sameSite: 'lax' });
  });

  it('are passed to the server-component / action client', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await createSupabaseServerClient();
    expect(passedCookieOptions()).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' });
  });

  it('are passed to the proxy session-refresh client', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await updateSupabaseSession(new NextRequest('https://armadillo.example/app'));
    expect(passedCookieOptions()).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' });
  });
});
