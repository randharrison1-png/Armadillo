import 'server-only';
import { createHash } from 'node:crypto';
import { scanSecrets, type SecretFinding } from '@/lib/secrets';

export { scanSecrets };
export type { SecretFinding };

/**
 * sha256 over the sorted `kind:line` list. The client echoes it back with "Publish anyway", so an
 * acknowledgement only counts for exactly the findings that were shown (the server recomputes it).
 */
export function secretsFingerprint(findings: readonly SecretFinding[]): string {
  const list = findings.map((f) => `${f.kind}:${f.line}`).sort();
  return createHash('sha256').update(list.join('\n'), 'utf8').digest('hex');
}
