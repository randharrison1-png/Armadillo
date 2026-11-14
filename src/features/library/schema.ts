import { z } from 'zod';
import { ALLOWED_EXTENSIONS, extensionOf, MAX_TEXT_BYTES } from '@/server/files/limits';
import { CATEGORIES } from './filters';

const OS = ['windows', 'windows_server', 'linux'] as const;

export const NAME_MAX = 200;

/** A library (universal) script. `session_generated` scripts are made by sessions, never by hand. */
export const createScriptSchema = z.object({
  name: z.string({ error: 'Enter a name.' }).trim().min(1, 'Enter a name.').max(NAME_MAX, `Use ${NAME_MAX} characters or fewer.`),
  filename: z
    .string({ error: 'Enter a filename.' })
    .trim()
    .min(1, 'Enter a filename.')
    .max(255, 'Use 255 characters or fewer.')
    .refine((f) => !/[\\/\0]/.test(f), 'A filename cannot contain slashes.')
    .refine((f) => ALLOWED_EXTENSIONS.script.includes(extensionOf(f)), `Use one of: ${ALLOWED_EXTENSIONS.script.join(' ')}`),
  category: z.enum(CATEGORIES, { error: 'Choose a category.' }),
  fn: z.enum(['universal_hardening', 'leads_audit'], { error: 'Choose a function.' }),
  description: z
    .string()
    .trim()
    .max(2000, 'Use 2000 characters or fewer.')
    .optional()
    .transform((d) => (d ? d : undefined)),
  osCompat: z.array(z.enum(OS)).min(1, 'Choose at least one operating system.'),
  content: z.string().refine((c) => new TextEncoder().encode(c).length <= MAX_TEXT_BYTES, 'Scripts can be at most 2 MB.'),
});

export type CreateScriptInput = z.input<typeof createScriptSchema>;
export type ScriptMeta = Omit<CreateScriptInput, 'content'>;

/** Editable script details (spec §6.2). Filename and function are fixed once created. */
export const updateScriptSchema = createScriptSchema.pick({ name: true, category: true, description: true, osCompat: true });
export type UpdateScriptInput = z.input<typeof updateScriptSchema>;
