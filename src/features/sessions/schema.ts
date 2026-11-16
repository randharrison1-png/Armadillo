import { z } from 'zod';
import type { OsType } from '@/lib/types';

export const OS_VALUES = ['windows', 'windows_server', 'linux'] as const satisfies readonly OsType[];

export const OS_LABEL: Record<OsType, string> = {
  windows: 'Windows',
  windows_server: 'Windows Server',
  linux: 'Linux',
};

export const TITLE_MAX = 120;

export const createSessionSchema = z.object({
  title: z
    .string({ error: 'Enter a title.' })
    .trim()
    .min(1, 'Enter a title.')
    .max(TITLE_MAX, `Use ${TITLE_MAX} characters or fewer.`),
  os: z.enum(OS_VALUES, { error: 'Choose an operating system.' }),
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
