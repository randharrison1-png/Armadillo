import 'server-only';
import type { OsType } from '@/lib/types';
import { logActivity } from '@/server/activity';
import { getClaudeKeyStatusFor, type ClaudeKeyStatus } from '@/server/claude/keys';
import { withUser } from '@/server/db/withUser';
import { defaultOsSchema, displayNameSchema, modelSchema } from './schema';

export type SettingsView = {
  displayName: string | null;
  defaultOs: OsType | null;
  /** null = server default. */
  model: string | null;
  key: ClaudeKeyStatus;
};

/** Input that failed validation; the message is user-facing. */
export class SettingsInputError extends Error {
  readonly name = 'SettingsInputError';
}

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new SettingsInputError(r.error.issues[0]?.message ?? 'Invalid value.');
  return r.data;
}

export async function getSettingsFor(userId: string): Promise<SettingsView> {
  const [row] = await withUser(userId, (tx) => tx<{ display_name: string | null; default_os: OsType | null; model: string | null }[]>`
    select display_name, default_os, model from public.profiles where id = ${userId}`);
  return {
    displayName: row?.display_name ?? null,
    defaultOs: row?.default_os ?? null,
    model: row?.model ?? null,
    key: await getClaudeKeyStatusFor(userId),
  };
}

export async function updateDisplayNameFor(userId: string, input: unknown): Promise<string | null> {
  const name = parse(displayNameSchema, input);
  await withUser(userId, async (tx) => {
    await tx`update public.profiles set display_name = ${name} where id = ${userId}`;
    await logActivity(tx, { action: 'settings.display_name.updated', entityType: 'profile', entityId: userId, meta: { cleared: name === null } });
  });
  return name;
}

export async function updateDefaultOsFor(userId: string, input: unknown): Promise<OsType | null> {
  const os = parse(defaultOsSchema, input);
  await withUser(userId, async (tx) => {
    await tx`update public.profiles set default_os = ${os} where id = ${userId}`;
    await logActivity(tx, { action: 'settings.default_os.updated', entityType: 'profile', entityId: userId, meta: { default_os: os } });
  });
  return os;
}

export async function updateModelFor(userId: string, input: unknown): Promise<string | null> {
  const model = parse(modelSchema, input);
  await withUser(userId, async (tx) => {
    await tx`update public.profiles set model = ${model} where id = ${userId}`;
    await logActivity(tx, { action: 'settings.model.updated', entityType: 'profile', entityId: userId, meta: { model } });
  });
  return model;
}

export async function logPasswordChangedFor(userId: string): Promise<void> {
  await withUser(userId, (tx) => logActivity(tx, { action: 'settings.password.changed', entityType: 'profile', entityId: userId }));
}
