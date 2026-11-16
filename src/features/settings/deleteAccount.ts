import 'server-only';
import { authMode } from '@/server/auth';
import { withService } from '@/server/db/withUser';
import { getFileStore, serviceClient, type FileStore } from '@/server/files/storage';

/** Account deletion could not complete. `stage` says how far it got; the message is user-facing. */
export class AccountDeletionError extends Error {
  readonly name = 'AccountDeletionError';
  constructor(
    readonly stage: 'files' | 'account',
    message: string,
  ) {
    super(message);
  }
}

export type DeleteAccountDeps = {
  store?: FileStore;
  /** Deletes the auth user; the ON DELETE CASCADE then removes every owned row. */
  deleteAuthUser?: (userId: string) => Promise<void>;
};

/** Test provider: auth.users is an ordinary table. */
async function deleteAuthUserSql(userId: string): Promise<void> {
  await withService(async (tx) => {
    await tx`delete from auth.users where id = ${userId}`;
  });
}

/** Supabase: the Auth admin API, which owns auth.users (cascades to every owner_id foreign key). */
async function deleteAuthUserSupabase(userId: string): Promise<void> {
  // Hard delete: deleteUser(id) without shouldSoftDelete removes the row, so the cascade runs.
  const { error } = await serviceClient().auth.admin.deleteUser(userId);
  if (error) throw new Error(`Auth user delete failed: ${error.message}`);
}

/**
 * Permanently deletes the account. Order matters:
 *  1. every object under private-files/{userId}/ is removed, then listed again to confirm none is
 *     left. If this fails, NOTHING has been deleted from the database and the user can retry;
 *  2. the auth.users row is deleted, and the cascade removes the profile, every private row
 *     (including insert-only history, see 0003_immutability) and the user's pastes.
 * `userId` must be the signed-in user's id.
 */
export async function deleteAccountFor(userId: string, deps: DeleteAccountDeps = {}): Promise<void> {
  const store = deps.store ?? getFileStore();
  try {
    await store.removePrefix(userId);
    const left = await store.list(userId);
    if (left.length > 0) throw new Error(`${left.length} file(s) remain after removal`);
  } catch (e) {
    console.error('[settings] account deletion stopped at file removal:', e instanceof Error ? e.message : 'unknown');
    throw new AccountDeletionError('files', 'Your files could not be deleted, so nothing was removed. Try again in a moment.');
  }
  try {
    await (deps.deleteAuthUser ?? (authMode() === 'test' ? deleteAuthUserSql : deleteAuthUserSupabase))(userId);
  } catch (e) {
    console.error('[settings] account deletion failed at the account row:', e instanceof Error ? e.message : 'unknown');
    throw new AccountDeletionError('account', 'Your files were deleted but the account could not be removed. Try again to finish.');
  }
}
