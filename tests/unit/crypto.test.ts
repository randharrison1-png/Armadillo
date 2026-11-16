// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  KeyEncryptionConfigError,
  SecretDecryptError,
  resetEncryptionKeyCache,
} from '@/server/security/crypto';

const ORIGINAL = process.env.KEY_ENCRYPTION_SECRET;

beforeEach(() => {
  process.env.KEY_ENCRYPTION_SECRET = 'unit-test-key-encryption-secret-0123456789';
  resetEncryptionKeyCache();
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.KEY_ENCRYPTION_SECRET;
  else process.env.KEY_ENCRYPTION_SECRET = ORIGINAL;
  resetEncryptionKeyCache();
});

/** Replaces one base64url character of the given part (1 = iv, 2 = tag, 3 = ciphertext). */
function flip(cipher: string, part: 1 | 2 | 3): string {
  const parts = cipher.split(':');
  const s = parts[part];
  const c = s[0] === 'A' ? 'B' : 'A';
  parts[part] = c + s.slice(1);
  return parts.join(':');
}

describe('encryptSecret / decryptSecret', () => {
  it('round-trip and tamper detection', () => {
    const plain = 'sk-ant-api03-EXAMPLE-key-material-ÄÖü-🔑';
    const cipher = encryptSecret(plain);

    // Versioned format v1:<iv>:<tag>:<ct>, base64url parts, 12-byte IV, 16-byte tag.
    expect(cipher).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    const [, iv, tag] = cipher.split(':');
    expect(Buffer.from(iv, 'base64url')).toHaveLength(12);
    expect(Buffer.from(tag, 'base64url')).toHaveLength(16);
    expect(cipher).not.toContain(plain);
    expect(cipher).not.toContain('EXAMPLE');

    expect(decryptSecret(cipher)).toBe(plain);

    // Random IV: the same plaintext never encrypts to the same ciphertext.
    expect(encryptSecret(plain)).not.toBe(cipher);

    // Any modified part fails authentication (never returns garbage).
    for (const part of [1, 2, 3] as const) {
      expect(() => decryptSecret(flip(cipher, part))).toThrow(SecretDecryptError);
    }
    // Wrong version, truncated or malformed input.
    expect(() => decryptSecret(cipher.replace(/^v1:/, 'v2:'))).toThrow(SecretDecryptError);
    expect(() => decryptSecret(cipher.split(':').slice(0, 3).join(':'))).toThrow(SecretDecryptError);
    expect(() => decryptSecret('not a ciphertext')).toThrow(SecretDecryptError);

    // A different server secret cannot decrypt it.
    process.env.KEY_ENCRYPTION_SECRET = 'a-completely-different-secret-value-9876543210';
    resetEncryptionKeyCache();
    expect(() => decryptSecret(cipher)).toThrow(SecretDecryptError);
  });

  it('binds the ciphertext to its context (associated data)', () => {
    const cipher = encryptSecret('sk-ant-context-bound', 'claude-key:user-a');
    expect(decryptSecret(cipher, 'claude-key:user-a')).toBe('sk-ant-context-bound');
    expect(() => decryptSecret(cipher, 'claude-key:user-b')).toThrow(SecretDecryptError);
    expect(() => decryptSecret(cipher)).toThrow(SecretDecryptError);
  });

  it('decrypt errors never include the plaintext or the secret', () => {
    const cipher = encryptSecret('sk-ant-do-not-leak');
    try {
      decryptSecret(flip(cipher, 3));
      expect.unreachable();
    } catch (e) {
      const text = `${(e as Error).message} ${(e as Error).stack ?? ''}`;
      expect(text).not.toContain('sk-ant-do-not-leak');
      expect(text).not.toContain(process.env.KEY_ENCRYPTION_SECRET!);
    }
  });

  it('accepts a 32-byte key as hex or base64, or derives one from a long passphrase', () => {
    const raw = randomBytes(32);
    for (const encoded of [raw.toString('hex'), raw.toString('base64'), raw.toString('base64url')]) {
      process.env.KEY_ENCRYPTION_SECRET = encoded;
      resetEncryptionKeyCache();
      const c = encryptSecret('x-secret');
      expect(decryptSecret(c)).toBe('x-secret');
    }
    // hex and base64 of the same bytes are the same key.
    process.env.KEY_ENCRYPTION_SECRET = raw.toString('hex');
    resetEncryptionKeyCache();
    const c = encryptSecret('same-key');
    process.env.KEY_ENCRYPTION_SECRET = raw.toString('base64');
    resetEncryptionKeyCache();
    expect(decryptSecret(c)).toBe('same-key');
  });

  it('missing or short secret is a clear configuration error', () => {
    for (const value of [undefined, '', '   ', 'too-short-secret']) {
      if (value === undefined) delete process.env.KEY_ENCRYPTION_SECRET;
      else process.env.KEY_ENCRYPTION_SECRET = value;
      resetEncryptionKeyCache();
      expect(() => encryptSecret('k')).toThrow(KeyEncryptionConfigError);
      expect(() => encryptSecret('k')).toThrow(/KEY_ENCRYPTION_SECRET/);
      expect(() => decryptSecret('v1:a:b:c')).toThrow(KeyEncryptionConfigError);
    }
  });
});
