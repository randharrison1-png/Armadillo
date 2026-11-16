'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { authMode, requireUser } from '@/server/auth';
import { changePassword } from '@/server/auth/password';
import { createSupabaseServerClient } from '@/server/auth/supabase';
import { testSignOut } from '@/server/auth/testAuth';
import { testClaudeConnection } from '@/server/claude/client';
import {
  clearClaudeKeyFor,
  ClaudeKeyInputError,
  getClaudeKeyStatusFor,
  saveClaudeKeyFor,
  type ClaudeKeyStatus,
} from '@/server/claude/keys';
import { KeyEncryptionConfigError } from '@/server/security/crypto';
import { AccountDeletionError, deleteAccountFor } from './deleteAccount';
import { DELETE_PHRASE, type PasswordResult, type SettingsActionResult, type TestConnectionResult } from './schema';
import { logPasswordChangedFor, SettingsInputError, updateDefaultOsFor, updateDisplayNameFor, updateModelFor } from './service';

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

// ------------------------------------------------------------------------------------------------
// Account, defaults, Claude model, password, deletion
// ------------------------------------------------------------------------------------------------

async function runSetting(fallback: string, fn: (userId: string) => Promise<unknown>): Promise<SettingsActionResult> {
  try {
    const user = await requireUser();
    await fn(user.id);
    revalidatePath('/app/settings');
    return { ok: true };
  } catch (e) {
    rethrowControlFlow(e);
    if (e instanceof SettingsInputError) return { ok: false, error: e.message };
    console.error('[settings] update failed:', e instanceof Error ? e.name : 'unknown');
    return { ok: false, error: fallback };
  }
}

export async function updateDisplayNameAction(name: string): Promise<SettingsActionResult> {
  return runSetting('Could not save the display name. Try again.', (id) => updateDisplayNameFor(id, name));
}

/** `os` is an OS value, or 'none' for no default. */
export async function updateDefaultOsAction(os: string): Promise<SettingsActionResult> {
  return runSetting('Could not save the default operating system. Try again.', (id) => updateDefaultOsFor(id, os));
}

/** `model` is a listed model id, or 'server-default'. */
export async function updateModelAction(model: string): Promise<SettingsActionResult> {
  return runSetting('Could not save the model. Try again.', (id) => updateModelFor(id, model));
}

/** One minimal request through the gateway with the key and model Claude would use. Never returns the key. */
export async function testConnectionAction(): Promise<TestConnectionResult> {
  try {
    const user = await requireUser();
    return await testClaudeConnection(user.id);
  } catch (e) {
    rethrowControlFlow(e);
    console.error('[settings] connection test failed:', e instanceof Error ? e.name : 'unknown');
    return { status: 'error', message: 'Could not run the test. Try again.' };
  }
}

/** Supabase: re-authenticates with the current password, then updates. Test provider: unsupported. */
export async function changePasswordAction(current: string, next: string): Promise<PasswordResult> {
  if (authMode() === 'test') return { ok: false, code: 'unsupported', error: 'Password is managed by the test sign-in provider.' };
  try {
    const user = await requireUser();
    const result = await changePassword(await createSupabaseServerClient(), { email: user.email, current, next });
    if (result.ok) await logPasswordChangedFor(user.id);
    return result;
  } catch (e) {
    rethrowControlFlow(e);
    console.error('[settings] password change failed:', e instanceof Error ? e.name : 'unknown');
    return { ok: false, code: 'failed', error: 'Could not change the password. Try again.' };
  }
}

/**
 * Permanently deletes the signed-in account (files first, then the auth user and, by cascade, every
 * row and paste), signs out and redirects to /?notice=account-deleted. The confirmation phrase is
 * checked here, not just in the dialog. Returns only on failure.
 */
export async function deleteAccountAction(confirmation: string): Promise<{ ok: false; error: string }> {
  if (typeof confirmation !== 'string' || confirmation.trim().toLowerCase() !== DELETE_PHRASE) {
    return { ok: false, error: `Type "${DELETE_PHRASE}" to confirm.` };
  }
  const user = await requireUser();
  try {
    await deleteAccountFor(user.id);
  } catch (e) {
    if (e instanceof AccountDeletionError) return { ok: false, error: e.message };
    console.error('[settings] account deletion failed:', e instanceof Error ? e.name : 'unknown');
    return { ok: false, error: 'Could not delete the account. Try again.' };
  }
  try {
    if (authMode() === 'test') await testSignOut();
    else await (await createSupabaseServerClient()).auth.signOut({ scope: 'local' });
  } catch {
    // The account is gone, so the session is already invalid; clearing the cookie is best effort.
  }
  redirect('/?notice=account-deleted');
}
