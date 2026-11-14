import 'server-only';
import { logActivity } from '@/server/activity';
import { withUser, type Tx } from '@/server/db/withUser';
import { decryptSecret, encryptSecret, KeyEncryptionConfigError, SecretDecryptError } from '@/server/security/crypto';

/**
 * Bring-your-own Claude API key: stored AES-256-GCM encrypted (bound to the user id) through the
 * SECURITY DEFINER functions in 0003c_claude_key.sql. Nothing here ever returns the key or its
 * ciphertext to a caller that could forward it to the browser: settings get `last4` only; the
 * decrypted key goes straight from resolveClaudeKeyFor() into the Anthropic client.
 */

export const MAX_KEY_LENGTH = 300;
const MIN_KEY_LENGTH = 8;

/** The key the user typed is not acceptable. The message is user-facing and never echoes the key. */
export class ClaudeKeyInputError extends Error {
  readonly name = 'ClaudeKeyInputError';
}

/** No user key and no server key: the Claude tab shows "Add a Claude API key in Settings". */
export class ClaudeKeyMissingError extends Error {
  readonly name = 'ClaudeKeyMissingError';
  readonly code = 'no_key';
  constructor() {
    super('Add a Claude API key in Settings');
  }
}

/** The user's saved key exists but cannot be decrypted (secret rotated or row tampered with). */
export class ClaudeKeyUnreadableError extends Error {
  readonly name = 'ClaudeKeyUnreadableError';
  readonly code = 'key_unreadable';
  constructor() {
    super('Your saved Claude API key could not be read. Save it again in Settings.');
  }
}

export type ClaudeKeyStatus = { hasUserKey: boolean; last4: string | null; serverKeyAvailable: boolean };

const keyContext = (userId: string) => `claude-key:${userId}`;

export const serverKey = (env: Record<string, string | undefined> = process.env): string | null => env.ANTHROPIC_API_KEY?.trim() || null;

/** Loose shape check: trimmed, 8–300 visible characters, no whitespace or control characters. */
export function normalizeClaudeKey(raw: unknown): string {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) throw new ClaudeKeyInputError('Enter your Claude API key.');
  if (key.length > MAX_KEY_LENGTH) throw new ClaudeKeyInputError(`That key is longer than ${MAX_KEY_LENGTH} characters.`);
  if (key.length < MIN_KEY_LENGTH) throw new ClaudeKeyInputError('That key is too short.');
  if (/[\s\x00-\x1f\x7f]/.test(key)) throw new ClaudeKeyInputError('That key contains spaces or invisible characters. Paste it again.');
  return key;
}

/** Encrypts and stores the user's key; returns only its last four characters. */
export async function saveClaudeKeyFor(userId: string, raw: unknown): Promise<{ last4: string }> {
  const key = normalizeClaudeKey(raw);
  const last4 = key.slice(-4);
  const cipher = encryptSecret(key, keyContext(userId)); // KeyEncryptionConfigError if the server secret is missing
  await withUser(userId, async (tx) => {
    const [had] = await tx<{ c: string | null }[]>`select public.get_claude_key_ciphertext() as c`;
    await tx`select public.set_claude_key(${cipher}, ${last4})`;
    await logActivity(tx, {
      action: 'settings.claude_key.saved',
      entityType: 'profile',
      entityId: userId,
      meta: { replaced: had?.c != null },
    });
  });
  return { last4 };
}

export async function clearClaudeKeyFor(userId: string): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx`select public.clear_claude_key()`;
    await logActivity(tx, { action: 'settings.claude_key.removed', entityType: 'profile', entityId: userId });
  });
}

export async function getClaudeKeyStatusFor(userId: string): Promise<ClaudeKeyStatus> {
  const [row] = await withUser(userId, (tx) => tx<{ claude_key_last4: string | null }[]>`
    select claude_key_last4 from public.profiles where id = ${userId}`);
  const last4 = row?.claude_key_last4 ?? null;
  return { hasUserKey: last4 !== null, last4, serverKeyAvailable: serverKey() !== null };
}

/** True when a Claude call can be attempted (user key saved or server key configured). */
export async function hasUsableKeyFor(tx: Tx): Promise<boolean> {
  if (serverKey()) return true;
  const [row] = await tx<{ c: string | null }[]>`select public.get_claude_key_ciphertext() as c`;
  return row?.c != null;
}

/**
 * The key and model for one Claude call: the user's decrypted key if saved, else
 * ANTHROPIC_API_KEY; neither → ClaudeKeyMissingError. A saved key that cannot be decrypted is an
 * error (ClaudeKeyUnreadableError / KeyEncryptionConfigError), never a silent fallback to the
 * server key.
 */
export async function resolveClaudeKeyFor(userId: string): Promise<{ apiKey: string; source: 'user' | 'server'; profileModel: string | null }> {
  const { cipher, model } = await withUser(userId, async (tx) => {
    const [c] = await tx<{ c: string | null }[]>`select public.get_claude_key_ciphertext() as c`;
    const [p] = await tx<{ model: string | null }[]>`select model from public.profiles where id = ${userId}`;
    return { cipher: c?.c ?? null, model: p?.model ?? null };
  });
  if (cipher) {
    try {
      return { apiKey: decryptSecret(cipher, keyContext(userId)), source: 'user', profileModel: model };
    } catch (e) {
      if (e instanceof KeyEncryptionConfigError) throw e;
      if (e instanceof SecretDecryptError) throw new ClaudeKeyUnreadableError();
      throw e;
    }
  }
  const env = serverKey();
  if (env) return { apiKey: env, source: 'server', profileModel: model };
  throw new ClaudeKeyMissingError();
}
