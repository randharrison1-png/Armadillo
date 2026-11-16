import 'server-only';
import { randomBytes } from 'node:crypto';
import { logActivity } from '@/server/activity';
import { withUser } from '@/server/db/withUser';
import { PublishRefused, validateForPublish } from './publish';
import { EXPIRES_IN_MS, publishPasteSchema, type PublishPasteInput } from './schema';

const SLUG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
export const MAX_SLUG_ATTEMPTS = 3;

/** 10 characters from [A-Za-z0-9_-] drawn from crypto randomness (64 symbols, so `& 63` has no modulo bias). */
export function generateSlug(): string {
  return Array.from(randomBytes(10), (b) => SLUG_ALPHABET[b & 63]).join('');
}

export class SlugCollisionError extends Error {
  constructor() {
    super('Could not allocate a unique paste link. Try again.');
  }
}

const isSlugCollision = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505' && (e as { constraint_name?: string }).constraint_name === 'pastes_slug_key';

/**
 * Publishes a new paste owned by `userId`. THE ONLY WRITER of new pastes; it is reached solely
 * through the pastebin server action (tests/unit/publish-boundary.test.ts), which the PublishDialog
 * calls after the user's explicit confirmation.
 *
 * Throws ZodError on bad input and PublishRefused when the user must confirm something first or is
 * rate-limited. Inside one transaction per attempt: rate limit -> secret check -> insert -> activity
 * log (slug, visibility, fromPrivate, secretsAcknowledged; never content). A slug unique violation
 * retries with a fresh slug, up to MAX_SLUG_ATTEMPTS attempts.
 *
 * A private-library copy stores only the copied text and from_private = true; it keeps no reference
 * to the script or version it came from.
 */
export async function publishPaste(
  userId: string,
  input: PublishPasteInput,
  deps: { newSlug?: () => string } = {},
): Promise<{ slug: string }> {
  const p = publishPasteSchema.parse(input);
  if (p.fromPrivate && !p.confirmPrivateSource) throw new PublishRefused({ code: 'private_source_unconfirmed' });
  const expiresAt = p.expiresIn ? new Date(Date.now() + EXPIRES_IN_MS[p.expiresIn]) : null;
  const newSlug = deps.newSlug ?? generateSlug;

  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = newSlug();
    try {
      return await withUser(userId, async (tx) => {
        const { secretsAcknowledged } = await validateForPublish(tx, {
          userId,
          action: 'create',
          content: p.content,
          contentChanged: true,
          visibility: p.visibility,
          expiresAt,
          acknowledgeSecrets: p.acknowledgeSecrets,
          secretsFingerprint: p.secretsFingerprint,
        });
        await tx`
          insert into paste.pastes (slug, title, content, language, visibility, expires_at, from_private)
          values (${slug}, ${p.title}, ${p.content}, ${p.language}, ${p.visibility}, ${expiresAt}, ${p.fromPrivate})`;
        await logActivity(tx, {
          action: 'paste.publish',
          entityType: 'paste',
          entityId: slug,
          meta: { slug, visibility: p.visibility, fromPrivate: p.fromPrivate, secretsAcknowledged },
        });
        return { slug };
      });
    } catch (e) {
      if (!isSlugCollision(e)) throw e;
    }
  }
  throw new SlugCollisionError();
}
