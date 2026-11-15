import 'server-only';
import { cookies } from 'next/headers';
import { assertTestAuthAllowed } from '@/server/auth/testAuth';

/**
 * Test-only fault injection for the loading and error state e2e tests (tests/e2e/states.spec.ts).
 *
 * A page calls `await applyFaults('<page>')` before its real work. If, and only if, the test auth
 * provider is allowed to run (ARMADILLO_TEST_AUTH=1, NODE_ENV not production, VERCEL unset: the same
 * guard as src/server/auth/testAuth.ts), it reads the `armadillo_test_faults` cookie:
 *
 *   {"delayMs": 2000, "fail": ["library"]}   // or "fail": "*"
 *
 * and waits delayMs (so the route's loading.tsx skeleton can be seen) and/or throws
 * ForcedTestFault (so the route's error.tsx can be seen). Anywhere else it returns immediately and
 * never even reads the cookie, so a request that carries the cookie to a real deployment does nothing.
 */

export const FAULT_COOKIE = 'armadillo_test_faults';
export const MAX_DELAY_MS = 10_000;

export const FAULT_PAGES = ['dashboard', 'sessions', 'session', 'library', 'script', 'reports', 'pastes', 'settings', 'paste'] as const;
export type FaultPage = (typeof FAULT_PAGES)[number];
export type Faults = { delayMs: number; fail: FaultPage[] | '*' };

/** The message is deliberately recognisable so tests can assert it never reaches the page. */
export class ForcedTestFault extends Error {
  constructor(page: string) {
    super(`Forced test failure on ${page}`);
    this.name = 'ForcedTestFault';
  }
}

type Env = Record<string, string | undefined>;

export function faultsEnabled(env: Env = process.env): boolean {
  try {
    assertTestAuthAllowed(env);
    return true;
  } catch {
    return false;
  }
}

/** Parses the (URL-encoded JSON) cookie value; null when absent or not shaped like faults. */
export function parseFaults(raw: string | undefined): Faults | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as { delayMs?: unknown; fail?: unknown };
  if (v.delayMs !== undefined && typeof v.delayMs !== 'number') return null;
  if (v.fail !== undefined && v.fail !== '*' && !Array.isArray(v.fail)) return null;
  const delayMs = Math.min(Math.max(Number.isFinite(v.delayMs) ? (v.delayMs as number) : 0, 0), MAX_DELAY_MS);
  const fail = v.fail === '*' ? '*' : Array.isArray(v.fail) ? v.fail.filter((p): p is FaultPage => (FAULT_PAGES as readonly unknown[]).includes(p)) : [];
  return { delayMs, fail };
}

type Deps = { env?: Env; readCookie?: () => Promise<string | undefined>; sleep?: (ms: number) => Promise<void> };

export async function applyFaults(page: FaultPage, deps: Deps = {}): Promise<void> {
  if (!faultsEnabled(deps.env ?? process.env)) return;
  const read = deps.readCookie ?? (async () => (await cookies()).get(FAULT_COOKIE)?.value);
  const faults = parseFaults(await read());
  if (!faults) return;
  if (faults.delayMs > 0) await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(faults.delayMs);
  if (faults.fail === '*' || faults.fail.includes(page)) throw new ForcedTestFault(page);
}
