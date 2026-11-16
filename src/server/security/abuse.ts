import 'server-only';
import { hmacWithDerivedKey } from './crypto';

export const ABUSE_REPORT_LABEL = 'abuse-report';

/**
 * The requester's address as the proxy in front of the app reports it: the FIRST entry of
 * X-Forwarded-For, else X-Real-IP, else a shared "unknown" bucket (stricter, never looser).
 * This trusts the proxy to overwrite client-supplied values; see docs/deploy.md.
 */
export function clientIp(headers: Pick<Headers, 'get'>): string {
  const first = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (first) return first.slice(0, 100);
  const real = headers.get('x-real-ip')?.trim();
  return real ? real.slice(0, 100) : 'unknown';
}

/** Pseudonymous reporter id: HMAC-SHA256 of the IP under a key derived for 'abuse-report'. The IP itself is never stored. */
export function reporterHash(ip: string): string {
  return hmacWithDerivedKey(ABUSE_REPORT_LABEL, ip);
}
