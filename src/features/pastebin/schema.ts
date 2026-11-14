import { z } from 'zod';
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
});
export type UpdatePasteInput = z.input<typeof updatePasteSchema>;
