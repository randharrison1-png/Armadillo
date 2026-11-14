'use server';

import { requireUser } from '@/server/auth';
import {
  clearClaudeKeyFor,
  ClaudeKeyInputError,
  getClaudeKeyStatusFor,
  saveClaudeKeyFor,
  type ClaudeKeyStatus,
} from '@/server/claude/keys';
import { KeyEncryptionConfigError } from '@/server/security/crypto';

/*
 * Claude key settings. Responses carry `last4` and booleans only — never the key or its
 * ciphertext. The key is encrypted server-side before it reaches the database.
 */

/** Redirect/auth control-flow errors from requireUser carry a digest and must propagate. */
function rethrowControlFlow(e: unknown) {
  if (typeof e === 'object' && e !== null && 'digest' in e) throw e;
}

function errorMessage(e: unknown, fallback: string): string {
  rethrowControlFlow(e);
  if (e instanceof ClaudeKeyInputError) return e.message;
  if (e instanceof KeyEncryptionConfigError) return 'Key storage is not configured on this server (KEY_ENCRYPTION_SECRET). Ask the administrator.';
  // Unknown failures are logged by name only (the input may be a key).
  console.error('[settings] Claude key change failed:', e instanceof Error ? e.name : 'unknown');
  return fallback;
}

/** Encrypts and stores the signed-in user's Claude API key. Returns only its last four characters. */
export async function saveClaudeKey(key: string): Promise<{ last4: string }> {
  const user = await requireUser();
  return saveClaudeKeyFor(user.id, key);
}

export async function removeClaudeKey(): Promise<void> {
  const user = await requireUser();
  await clearClaudeKeyFor(user.id);
}

export async function getClaudeKeyStatus(): Promise<ClaudeKeyStatus> {
  const user = await requireUser();
  return getClaudeKeyStatusFor(user.id);
}

export async function saveClaudeKeyAction(key: string): Promise<{ ok: true; last4: string } | { ok: false; error: string }> {
  try {
    const { last4 } = await saveClaudeKey(key);
    return { ok: true, last4 };
  } catch (e) {
    return { ok: false, error: errorMessage(e, 'Could not save the key. Try again.') };
  }
}

export async function removeClaudeKeyAction(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await removeClaudeKey();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e, 'Could not remove the key. Try again.') };
  }
}
