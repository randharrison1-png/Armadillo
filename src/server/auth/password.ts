import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PASSWORD_MIN, type PasswordResult } from '@/features/settings/schema';

/**
 * Supabase provider: change the signed-in user's password. The current password is verified first
 * (signInWithPassword), so a stolen session cookie alone cannot set a new password. Provider error
 * text is passed through only for weak-password rules; everything else is a fixed message.
 */
export async function changePassword(
  supabase: SupabaseClient,
  input: { email: string; current: string; next: string },
): Promise<PasswordResult> {
  const { email, current, next } = input;
  if (typeof current !== 'string' || current === '') return { ok: false, code: 'invalid', error: 'Enter your current password.' };
  if (typeof next !== 'string' || next.length < PASSWORD_MIN) {
    return { ok: false, code: 'invalid', error: `The new password must be at least ${PASSWORD_MIN} characters.` };
  }
  if (next.length > 200) return { ok: false, code: 'invalid', error: 'The new password is too long.' };
  if (next === current) return { ok: false, code: 'invalid', error: 'Choose a password different from the current one.' };

  const { error: reauth } = await supabase.auth.signInWithPassword({ email, password: current });
  if (reauth) return { ok: false, code: 'wrong_password', error: 'Your current password is incorrect.' };

  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) {
    if (error.code === 'weak_password') return { ok: false, code: 'weak_password', error: error.message };
    return { ok: false, code: 'failed', error: 'Could not change the password. Try again.' };
  }
  return { ok: true };
}
