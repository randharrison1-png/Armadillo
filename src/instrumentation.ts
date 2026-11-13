/**
 * Runs once when a Next.js server instance starts. Fails startup loudly if the test auth provider
 * is enabled where it must not be (NODE_ENV=production or VERCEL set) or is misconfigured.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.ARMADILLO_TEST_AUTH === '1') {
    const { assertTestAuthAllowed } = await import('@/server/auth/testAuth');
    assertTestAuthAllowed();
  }
}
