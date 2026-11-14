/**
 * High-impact operation scanner (spec §5.4) — server entry point. The implementation is pure and
 * shared with the proposal diff tab, so it lives in src/lib/highImpact.ts (client bundles must not
 * reach src/server/security, see tests/unit/claude-gateway.test.ts). See that file for the rules,
 * what the scanner cannot see, and the flag id format.
 */
export {
  flagId,
  HIGH_IMPACT_CATEGORIES,
  HIGH_IMPACT_LABEL,
  lineCount,
  linesOf,
  MATCH_MAX,
  mergeFlags,
  missingAcknowledgements,
  requiredFlags,
  resolveClaudeFlags,
  scanHighImpact,
  type ClaudeFlagInput,
} from '@/lib/highImpact';
