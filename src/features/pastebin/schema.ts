import { z } from 'zod';
import type { SecretFinding } from '@/lib/secrets';
import type { ScriptLanguage } from '@/lib/types';

export const PASTE_LANGUAGES = ['powershell', 'bash', 'batch', 'text', 'markdown'] as const satisfies readonly ScriptLanguage[];
export const PASTE_VISIBILITIES = ['public', 'unlisted'] as const;
export type PasteVisibility = (typeof PASTE_VISIBILITIES)[number];

export const LANGUAGE_LABEL: Record<ScriptLanguage, string> = {
  powershell: 'PowerShell',
  bash: 'Bash',
  batch: 'Batch',
  text: 'Plain text',
  markdown: 'Markdown',
};
const EXTENSION: Record<ScriptLanguage, string> = { powershell: 'ps1', bash: 'sh', batch: 'bat', text: 'txt', markdown: 'md' };
export const extensionFor = (language: ScriptLanguage): string => EXTENSION[language];

export const SLUG_RE = /^[A-Za-z0-9_-]{10}$/;
export const TITLE_MAX = 200;
export const CONTENT_MAX_BYTES = 512 * 1024;
export const PAGE_SIZE = 20;

export const slugSchema = z.string().regex(SLUG_RE, 'Invalid paste link.');

const contentSchema = z
  .string()
  .refine((c) => c.trim().length > 0, 'Content cannot be empty.')
  .refine((c) => !c.includes('\0'), 'Content cannot contain NUL characters.')
  .refine((c) => new TextEncoder().encode(c).length <= CONTENT_MAX_BYTES, 'Pastes can be at most 512 KB.');

/** Fields an owner can change. Omitted fields stay as they are; `expiresAt: null` means never expires. */
export const updatePasteSchema = z.object({
  slug: slugSchema,
  title: z
    .string()
    .trim()
    .max(TITLE_MAX, `Use ${TITLE_MAX} characters or fewer.`)
    .transform((t) => (t === '' ? null : t))
    .nullable()
    .optional(),
  content: contentSchema.optional(),
  language: z.enum(PASTE_LANGUAGES, { error: 'Choose a language.' }).optional(),
  visibility: z.enum(PASTE_VISIBILITIES, { error: 'Choose a visibility.' }).optional(),
  expiresAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'Enter a valid expiry.')
    .refine((s) => Date.parse(s) > Date.now(), 'The expiry must be in the future.')
    .nullable()
    .optional(),
  /** Set when the user confirmed a secret-scan warning (enforced by the publish seam). */
  acknowledgeSecrets: z.boolean().optional(),
  /** The fingerprint the warning carried; an acknowledgement only counts together with a matching one. */
  secretsFingerprint: z.string().max(64).optional(),
});
export type UpdatePasteInput = z.input<typeof updatePasteSchema>;

export const EXPIRES_IN = ['1h', '1d', '7d', '30d'] as const;
export type ExpiresIn = (typeof EXPIRES_IN)[number];
export const EXPIRES_IN_MS: Record<ExpiresIn, number> = { '1h': 3_600_000, '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

/** New paste. Nothing here is ever filled in by the server: publishing is always an explicit user action. */
export const publishPasteSchema = z.object({
  title: z.string().trim().min(1, 'Enter a title.').max(TITLE_MAX, `Use ${TITLE_MAX} characters or fewer.`),
  content: contentSchema,
  language: z.enum(PASTE_LANGUAGES, { error: 'Choose a language.' }),
  visibility: z.enum(PASTE_VISIBILITIES, { error: 'Choose a visibility.' }),
  expiresIn: z.enum(EXPIRES_IN, { error: 'Choose an expiry.' }).nullable(),
  /** The content was copied from the user's private library. */
  fromPrivate: z.boolean(),
  acknowledgeSecrets: z.boolean(),
  secretsFingerprint: z.string().max(64).optional(),
  /** Required (true) when fromPrivate: the user confirmed publishing a copy of private material. */
  confirmPrivateSource: z.boolean(),
});
export type PublishPasteInput = z.input<typeof publishPasteSchema>;

/** Why a publish or a public edit was refused before anything was written. Safe to send to the client. */
export type PublishRefusal =
  | { code: 'secrets'; findings: SecretFinding[]; fingerprint: string }
  | { code: 'rate_limited'; retryAfter: number }
  | { code: 'private_source_unconfirmed' };

/** The signed-in owner's view of one of their pastes (client-safe type, kept out of service.ts). */
export type OwnPaste = {
  slug: string;
  title: string | null;
  language: ScriptLanguage;
  visibility: PasteVisibility;
  expires_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
export type OwnPasteWithContent = OwnPaste & { content: string };
