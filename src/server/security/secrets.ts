import 'server-only';
import { createHash } from 'node:crypto';
import { fingerprintInput, scanSecrets, type SecretFinding } from '@/lib/secrets';

export { scanSecrets };
export type { SecretFinding };

/**
 * sha256 over the sorted `kind:line` list. The client echoes it back with "Publish anyway", so an
 * acknowledgement only counts for exactly the findings that were shown (the server recomputes it).
 */
export function secretsFingerprint(findings: readonly SecretFinding[]): string {
  return createHash('sha256').update(fingerprintInput(findings), 'utf8').digest('hex');
}
