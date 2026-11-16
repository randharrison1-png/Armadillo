/**
 * SIGNUPS_ENABLED (default true): set it to "false" to close self-service sign-up on a deployment
 * (e.g. a personal instance whose ANTHROPIC_API_KEY should not serve strangers). Existing accounts
 * still sign in; new accounts can then only be created from the Supabase dashboard.
 */
export function signupsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SIGNUPS_ENABLED?.trim().toLowerCase() !== 'false';
}

export const SIGNUPS_DISABLED_MESSAGE = 'Sign-up is not open on this server. Ask the administrator for an account.';
