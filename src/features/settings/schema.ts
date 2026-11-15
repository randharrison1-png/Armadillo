import { z } from 'zod';
import { OS_VALUES } from '@/features/sessions/schema';

export { OS_LABEL, OS_VALUES } from '@/features/sessions/schema';

/** What the user must type to confirm account deletion (compared trimmed, case-insensitively). */
export const DELETE_PHRASE = 'delete my account';

export const DISPLAY_NAME_MAX = 100;
export const PASSWORD_MIN = 8;

/** The "Server default" choice: stored as null, so the server's CLAUDE_MODEL / built-in default applies. */
export const SERVER_DEFAULT_MODEL = 'server-default';

export const MODEL_OPTIONS = [
  { value: SERVER_DEFAULT_MODEL, label: 'Server default' },
  { value: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5' },
  { value: 'claude-opus-5-5', label: 'claude-opus-5-5' },
  { value: 'claude-haiku-5-5', label: 'claude-haiku-5-5' },
] as const;

export const MODEL_VALUES = MODEL_OPTIONS.map((m) => m.value) as readonly string[];

export const displayNameSchema = z
  .string({ error: 'Enter a display name.' })
  .trim()
  .max(DISPLAY_NAME_MAX, `Use ${DISPLAY_NAME_MAX} characters or fewer.`)
  .transform((v) => (v === '' ? null : v));

export const defaultOsSchema = z.union([z.literal('none'), z.enum(OS_VALUES)], { error: 'Choose an operating system.' }).transform((v) => (v === 'none' ? null : v));

export const modelSchema = z
  .string({ error: 'Choose a model.' })
  .refine((v) => MODEL_VALUES.includes(v), 'Choose one of the listed models.')
  .transform((v) => (v === SERVER_DEFAULT_MODEL ? null : v));

export type SettingsActionResult = { ok: true } | { ok: false; error: string };

export type TestConnectionResult =
  | { status: 'ok'; model: string; source: 'user' | 'server' }
  | { status: 'invalid_key' }
  | { status: 'network' }
  | { status: 'no_key' }
  | { status: 'error'; message: string };

export type PasswordResult =
  | { ok: true }
  | { ok: false; code: 'unsupported' | 'wrong_password' | 'weak_password' | 'invalid' | 'failed'; error: string };

/**
 * Largest export (uncompressed data JSON + private files). The zip is built in memory and uploaded to
 * Storage in one request, so it stays under Supabase's default 50 MB object limit.
 */
export const EXPORT_MAX_BYTES = 50 * 1024 * 1024;
export const EXPORT_LINK_TTL_SECONDS = 10 * 60;
