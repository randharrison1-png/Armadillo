import type { PasteVisibility } from './schema';

export type PublishCheck = {
  userId: string;
  action: 'create' | 'update';
  /** The content as it will be stored after this write (stored content when the edit does not change it). */
  content: string;
  /** Visibility after this write. */
  visibility: PasteVisibility;
  /** Visibility before this write; undefined on create. */
  prevVisibility?: PasteVisibility;
  /** Expiry after this write (null = never). */
  expiresAt: Date | null;
  /** The user acknowledged a secret-scan warning (Task 20). */
  acknowledgeSecrets?: boolean;
};

/**
 * The single seam for pre-publish checks on pastes. Task 20 adds the secret scan and the edit rate
 * limit here. Create calls it, and updatePasteFor calls it on EVERY update that changes anything
 * (metadata-only edits included, e.g. unlisted -> public or removing an expiry), inside the write
 * transaction so a rejection (throw) aborts the write. A no-op for now.
 */
export async function validateForPublish(input: PublishCheck): Promise<void> {
  void input;
}
