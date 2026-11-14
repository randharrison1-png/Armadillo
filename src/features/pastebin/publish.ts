import { scanSecrets, secretsFingerprint } from '@/server/security/secrets';
import { checkRateLimit, EDIT_LIMIT, PUBLISH_LIMIT } from '@/server/security/rateLimit';
import type { Tx } from '@/server/db/withUser';
import type { PasteVisibility, PublishRefusal } from './schema';

export type PublishCheck = {
  userId: string;
  action: 'create' | 'update';
  /** The content as it will be stored after this write (stored content when the edit does not change it). */
  content: string;
  /** Whether this write changes the stored content (always true on create). */
  contentChanged: boolean;
  /** Visibility after this write. */
  visibility: PasteVisibility;
  /** Visibility before this write; undefined on create. */
  prevVisibility?: PasteVisibility;
  /** Expiry after this write (null = never). */
  expiresAt: Date | null;
  /** The user acknowledged a secret-scan warning; only honoured with a matching secretsFingerprint. */
  acknowledgeSecrets?: boolean;
  secretsFingerprint?: string;
};

/** Thrown by the seam to refuse a write. The caller's transaction rolls back, so nothing is stored or counted. */
export class PublishRefused extends Error {
  readonly name = 'PublishRefused';
  constructor(readonly refusal: PublishRefusal) {
    super(`Publish refused: ${refusal.code}`);
  }
}

/** True when this write makes content public that was not public before (create, or unlisted -> public). */
export const isPublishing = (c: Pick<PublishCheck, 'action' | 'visibility' | 'prevVisibility'>) =>
  c.action === 'create' || (c.visibility === 'public' && c.prevVisibility !== 'public');

/**
 * The single seam for pre-publish checks on pastes, run INSIDE the write transaction (`tx`) so a
 * refusal (a thrown PublishRefused) aborts the write and the rate-limit hit with it, and so no second
 * pooled connection is needed while the paste row is locked.
 *
 * Called by createPaste (action 'create') and by updatePasteFor on EVERY update that changes
 * anything, metadata-only edits included (e.g. unlisted -> public or removing an expiry).
 *  1. Rate limit: creates and updates that flip to public count as publishes (10/hour/user);
 *     every other edit is an edit (60/hour/user).
 *  2. Secret scan (pure) on create, on every content change and on every flip to public. Findings
 *     refuse the write unless the caller acknowledged exactly these findings.
 */
/** Resolves with whether secrets were found and knowingly acknowledged (for the activity log). */
export async function validateForPublish(tx: Tx, input: PublishCheck): Promise<{ secretsAcknowledged: boolean }> {
  const publishing = isPublishing(input);
  const { limit, windowSec } = publishing ? PUBLISH_LIMIT : EDIT_LIMIT;
  const rate = await checkRateLimit(tx, `${publishing ? 'publish' : 'edit'}:${input.userId}`, limit, windowSec);
  if (!rate.ok) throw new PublishRefused({ code: 'rate_limited', retryAfter: rate.retryAfter });

  if (input.action === 'create' || input.contentChanged || publishing) {
    const findings = scanSecrets(input.content);
    if (findings.length > 0) {
      const fingerprint = secretsFingerprint(findings);
      if (!(input.acknowledgeSecrets === true && input.secretsFingerprint === fingerprint)) {
        throw new PublishRefused({ code: 'secrets', findings, fingerprint });
      }
      return { secretsAcknowledged: true };
    }
  }
  return { secretsAcknowledged: false };
}
