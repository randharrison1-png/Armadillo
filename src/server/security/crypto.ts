import 'server-only';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption for secrets at rest (users' Claude API keys): AES-256-GCM with a random
 * 12-byte IV and a 16-byte auth tag.
 *
 * Ciphertext format (versioned so the scheme can change later): `v1:<iv>:<tag>:<ciphertext>`,
 * each part base64url. An optional `context` string is bound as GCM associated data (e.g.
 * `claude-key:<userId>`), so a ciphertext copied to another row does not decrypt.
 *
 * KEY_ENCRYPTION_SECRET (server env, never sent anywhere) gives the 32-byte key:
 *   - 64 hex characters, or base64/base64url of exactly 32 bytes → used as the key directly;
 *   - any other value of at least 32 characters → key derived with HKDF-SHA256
 *     (salt "armadillo.key-encryption", info "aes-256-gcm v1");
 *   - missing or shorter → KeyEncryptionConfigError the first time a secret is encrypted or
 *     decrypted (only users who save a key need it).
 * Generate one with `openssl rand -base64 32`. Rotating the secret makes stored keys unreadable;
 * users then save their key again.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_PASSPHRASE = 32;

/** The server is not configured to encrypt secrets. The message names the env var, never a value. */
export class KeyEncryptionConfigError extends Error {
  readonly name = 'KeyEncryptionConfigError';
  constructor() {
    super(
      'KEY_ENCRYPTION_SECRET is missing or shorter than 32 characters. Set it to a random 32-byte value ' +
        '(e.g. `openssl rand -base64 32`) to store Claude API keys.',
    );
  }
}

/** A ciphertext could not be decrypted: malformed, tampered with, or encrypted under another secret. */
export class SecretDecryptError extends Error {
  readonly name = 'SecretDecryptError';
  constructor() {
    super('Stored secret could not be decrypted.');
  }
}

let cached: { secret: string; key: Buffer } | null = null;

/** Test helper: forget the derived key (after changing KEY_ENCRYPTION_SECRET). */
export function resetEncryptionKeyCache() {
  cached = null;
}

function decodeRawKey(s: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/]{43}=?$/.test(s) || /^[A-Za-z0-9_-]{43}$/.test(s)) {
    const b = Buffer.from(s, s.includes('+') || s.includes('/') || s.endsWith('=') ? 'base64' : 'base64url');
    if (b.length === 32) return b;
  }
  return null;
}

function encryptionKey(): Buffer {
  const secret = (process.env.KEY_ENCRYPTION_SECRET ?? '').trim();
  if (cached && cached.secret === secret) return cached.key;
  if (secret.length < MIN_PASSPHRASE) throw new KeyEncryptionConfigError();
  const key =
    decodeRawKey(secret) ??
    Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'armadillo.key-encryption', 'aes-256-gcm v1', 32));
  cached = { secret, key };
  return key;
}

const aad = (context: string) => Buffer.from(`${VERSION}|${context}`, 'utf8');

export function encryptSecret(plain: string, context = ''): string {
  const key = encryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(context));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
}

export function decryptSecret(cipherText: string, context = ''): string {
  const key = encryptionKey();
  const parts = typeof cipherText === 'string' ? cipherText.split(':') : [];
  if (parts.length !== 4 || parts[0] !== VERSION || !parts.slice(1).every((p) => /^[A-Za-z0-9_-]+$/.test(p))) {
    throw new SecretDecryptError();
  }
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ct = Buffer.from(parts[3], 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretDecryptError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // Never surface the underlying error (it carries no secret, but keep one opaque failure mode).
    throw new SecretDecryptError();
  }
}

/**
 * A 32-byte key for a purpose other than encrypting secrets, derived from KEY_ENCRYPTION_SECRET
 * with HKDF-SHA256 (info = `label`), so each purpose gets an independent key and none reveals the
 * encryption key. Throws KeyEncryptionConfigError when the secret is not configured.
 */
export function deriveKey(label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', encryptionKey(), 'armadillo.derived-key', label, 32));
}

/** HMAC-SHA256 (hex) of `value` under the key derived for `label`. */
export function hmacWithDerivedKey(label: string, value: string): string {
  return createHmac('sha256', deriveKey(label)).update(value, 'utf8').digest('hex');
}
