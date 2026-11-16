import { beforeEach, describe, expect, it, vi } from 'vitest';

const createSupabaseServerClient = vi.fn();
vi.mock('@/server/auth/supabase', () => ({ createSupabaseServerClient: () => createSupabaseServerClient() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

const { signupsEnabled, SIGNUPS_DISABLED_MESSAGE } = await import('@/server/auth/signups');
const { signUpWithPassword } = await import('@/server/auth/actions');

const form = () => {
  const f = new FormData();
  f.set('email', 'new.user@example.test');
  f.set('password', 'long-enough-password');
  return f;
};

beforeEach(() => {
  vi.unstubAllEnvs();
  createSupabaseServerClient.mockReset();
});

describe('SIGNUPS_ENABLED', () => {
  it('defaults to enabled; only "false" (any case, trimmed) disables', () => {
    expect(signupsEnabled({})).toBe(true);
    expect(signupsEnabled({ SIGNUPS_ENABLED: '' })).toBe(true);
    expect(signupsEnabled({ SIGNUPS_ENABLED: 'true' })).toBe(true);
    expect(signupsEnabled({ SIGNUPS_ENABLED: 'false' })).toBe(false);
    expect(signupsEnabled({ SIGNUPS_ENABLED: ' FALSE ' })).toBe(false);
  });

  it('sign-up refuses with a clear message and never reaches Supabase when disabled', async () => {
    vi.stubEnv('ARMADILLO_TEST_AUTH', '');
    vi.stubEnv('SIGNUPS_ENABLED', 'false');
    expect(await signUpWithPassword({}, form())).toEqual({ error: SIGNUPS_DISABLED_MESSAGE });
    expect(SIGNUPS_DISABLED_MESSAGE).toMatch(/not open/i);
    expect(createSupabaseServerClient).not.toHaveBeenCalled();
  });

  it('sign-up still reaches Supabase when enabled', async () => {
    vi.stubEnv('ARMADILLO_TEST_AUTH', '');
    vi.stubEnv('SIGNUPS_ENABLED', 'true');
    const signUp = vi.fn(async () => ({ data: { session: null }, error: null }));
    createSupabaseServerClient.mockResolvedValue({ auth: { signUp } });
    expect(await signUpWithPassword({}, form())).toEqual({ message: 'Check your email to confirm your account, then sign in.' });
    expect(signUp).toHaveBeenCalledOnce();
  });
});
