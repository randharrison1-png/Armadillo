// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { applyFaults, FAULT_COOKIE, faultsEnabled, ForcedTestFault, MAX_DELAY_MS, parseFaults } from '@/server/testing/faults';

const SECRET = 'unit-test-secret-0123456789abcdef-xyz';
const TEST_ENV = { NODE_ENV: 'test', ARMADILLO_TEST_AUTH: '1', TEST_AUTH_SECRET: SECRET };
const cookie = (v: object | string) => encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v));

function harness(env: Record<string, string | undefined>, value: string | undefined) {
  const read = vi.fn(async () => value);
  const sleep = vi.fn(async () => {});
  return { read, sleep, run: (page: Parameters<typeof applyFaults>[0]) => applyFaults(page, { env, readCookie: read, sleep }) };
}

describe('test-only fault injection (delay / forced failure)', () => {
  it('is enabled only where the test auth provider may run', () => {
    expect(faultsEnabled(TEST_ENV)).toBe(true);
    expect(faultsEnabled({ ...TEST_ENV, NODE_ENV: 'development' })).toBe(true);
  });

  it.each([
    ['NODE_ENV=production', { ...TEST_ENV, NODE_ENV: 'production' }],
    ['VERCEL is set', { ...TEST_ENV, VERCEL: '1' }],
    ['ARMADILLO_TEST_AUTH unset', { NODE_ENV: 'test', TEST_AUTH_SECRET: SECRET }],
    ['ARMADILLO_TEST_AUTH not "1"', { ...TEST_ENV, ARMADILLO_TEST_AUTH: 'true' }],
    ['no TEST_AUTH_SECRET', { NODE_ENV: 'test', ARMADILLO_TEST_AUTH: '1' }],
  ])('is inert when %s: no cookie is read, no delay, no failure', async (_name, env) => {
    expect(faultsEnabled(env)).toBe(false);
    const h = harness(env, cookie({ delayMs: 500, fail: '*' }));
    await expect(h.run('library')).resolves.toBeUndefined();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it('does nothing without the cookie or with a malformed one', async () => {
    for (const value of [undefined, '', '%E0%A4%A', cookie('not json'), cookie('[]'), cookie({ delayMs: 'soon' }), cookie({ fail: 5 })]) {
      const h = harness(TEST_ENV, value);
      await expect(h.run('library')).resolves.toBeUndefined();
      expect(h.sleep).not.toHaveBeenCalled();
    }
  });

  it('delays by delayMs (capped) for every page', async () => {
    const h = harness(TEST_ENV, cookie({ delayMs: 1200 }));
    await h.run('reports');
    expect(h.sleep).toHaveBeenCalledWith(1200);

    const big = harness(TEST_ENV, cookie({ delayMs: 10 * 60_000 }));
    await big.run('reports');
    expect(big.sleep).toHaveBeenCalledWith(MAX_DELAY_MS);
  });

  it('throws only for the listed pages, or for all with "*"', async () => {
    const some = harness(TEST_ENV, cookie({ fail: ['library', 'settings'] }));
    await expect(some.run('library')).rejects.toBeInstanceOf(ForcedTestFault);
    await expect(some.run('settings')).rejects.toBeInstanceOf(ForcedTestFault);
    await expect(some.run('reports')).resolves.toBeUndefined();

    const all = harness(TEST_ENV, cookie({ fail: '*' }));
    await expect(all.run('pastes')).rejects.toBeInstanceOf(ForcedTestFault);
  });

  it('delays before failing, so loading can be observed before the error appears', async () => {
    const order: string[] = [];
    await expect(
      applyFaults('sessions', {
        env: TEST_ENV,
        readCookie: async () => cookie({ delayMs: 50, fail: ['sessions'] }),
        sleep: async () => void order.push('sleep'),
      }).catch((e) => {
        order.push('throw');
        throw e;
      }),
    ).rejects.toThrow();
    expect(order).toEqual(['sleep', 'throw']);
  });

  it('parseFaults ignores unknown page keys and negative delays', () => {
    expect(parseFaults(cookie({ delayMs: -5, fail: ['nope', 'library'] }))).toEqual({ delayMs: 0, fail: ['library'] });
    expect(parseFaults(undefined)).toBeNull();
  });

  it('uses a fixed cookie name', () => {
    expect(FAULT_COOKIE).toBe('armadillo_test_faults');
  });
});
