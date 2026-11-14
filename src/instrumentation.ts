/**
 * Runs once when a Next.js server instance starts. Fails startup loudly if the test auth provider
 * is enabled where it must not be (NODE_ENV=production or VERCEL set) or is misconfigured.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if ((process.env.KEY_ENCRYPTION_SECRET ?? '').trim().length < 32) {
    // Not fatal: only saving or using a personal Claude key needs it (that fails with a clear error).
    console.warn('[armadillo] KEY_ENCRYPTION_SECRET is missing or shorter than 32 characters: users cannot save Claude API keys.');
  }
  if (process.env.ARMADILLO_TEST_AUTH === '1') {
    const { assertTestAuthAllowed } = await import('@/server/auth/testAuth');
    assertTestAuthAllowed();
  }
}
