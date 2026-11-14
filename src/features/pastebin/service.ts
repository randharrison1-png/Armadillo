import 'server-only';
import { withAnon, withUser } from '@/server/db/withUser';
import { logActivity } from '@/server/activity';
import type { ScriptLanguage } from '@/lib/types';
import { validateForPublish } from './publish';
import { PAGE_SIZE, SLUG_RE, updatePasteSchema, type OwnPaste, type OwnPasteWithContent, type PasteVisibility, type UpdatePasteInput } from './schema';

/** A live paste as the public sees it. Never carries owner_id. */
export type PublicPaste = {
  id: string;
  slug: string;
  title: string | null;
  content: string;
  language: ScriptLanguage;
  visibility: PasteVisibility;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type PasteListItem = {
  slug: string;
  title: string | null;
  language: ScriptLanguage;
  created_at: Date;
  /** First non-empty line, plain text, truncated. */
  preview: string;
};

export type { OwnPaste, OwnPasteWithContent } from './schema';

export class PasteNotFoundError extends Error {
  constructor() {
    super('Paste not found.');
  }
}

const PREVIEW_MAX = 120;

export function firstLine(text: string): string {
  const line = text.split(/\r\n|\r|\n/).find((l) => l.trim() !== '') ?? '';
  const t = line.trim();
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX)}…` : t;
}

/** Live (not deleted, not expired) paste by slug, public or unlisted. Always read as anon. */
export async function getPaste(slug: string): Promise<PublicPaste | null> {
  if (!SLUG_RE.test(slug)) return null;
  const rows = await withAnon(
    (tx) => tx<PublicPaste[]>`
      select id, slug, title, content, language, visibility, expires_at, created_at, updated_at
      from paste.pastes where slug = ${slug}`,
  );
  return rows[0] ?? null;
}

/** Whether `userId` owns `slug` (read as the user; RLS applies). Never exposes the owner id itself. */
export async function ownsPaste(userId: string, slug: string): Promise<boolean> {
  if (!SLUG_RE.test(slug)) return false;
  const rows = await withUser(
    userId,
    (tx) => tx`select 1 from paste.pastes where slug = ${slug} and owner_id = auth.uid() and deleted_at is null`,
  );
  return rows.length > 0;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Live PUBLIC pastes only (unlisted are never listed), newest first, 20 per page. Deleted rows are
 * excluded by RLS (anon has no column privilege on deleted_at, so it is not referenced here).
 */
export async function searchPublicPastes(q: {
  text?: string;
  language?: string;
  page: number;
}): Promise<{ items: PasteListItem[]; hasNext: boolean; page: number }> {
  const page = Number.isInteger(q.page) && q.page >= 1 ? Math.min(q.page, 10_000) : 1;
  const text = q.text?.trim().slice(0, 200) ?? '';
  const pattern = text ? `%${escapeLike(text)}%` : null;
  const language = q.language && (['powershell', 'bash', 'batch', 'text', 'markdown'] as string[]).includes(q.language) ? q.language : null;
  const rows = await withAnon(
    (tx) => tx<{ slug: string; title: string | null; language: ScriptLanguage; created_at: Date; head: string }[]>`
      select slug, title, language, created_at, left(content, 600) as head
      from paste.pastes
      where visibility = 'public'
        and (expires_at is null or expires_at > now())
        ${language ? tx`and language = ${language}` : tx``}
        ${pattern ? tx`and (title ilike ${pattern} escape '\\' or content ilike ${pattern} escape '\\')` : tx``}
      order by created_at desc, id desc
      limit ${PAGE_SIZE + 1} offset ${(page - 1) * PAGE_SIZE}`,
  );
  return {
    items: rows.slice(0, PAGE_SIZE).map((r) => ({ slug: r.slug, title: r.title, language: r.language, created_at: r.created_at, preview: firstLine(r.head) })),
    hasNext: rows.length > PAGE_SIZE,
    page,
  };
}

/** The signed-in user's own pastes, including expired and deleted ones (no content). */
export async function listMyPastes(userId: string): Promise<OwnPaste[]> {
  return withUser(
    userId,
    (tx) => tx<OwnPaste[]>`
      select slug, title, language, visibility, expires_at, deleted_at, created_at, updated_at
      from paste.pastes where owner_id = auth.uid()
      order by created_at desc, id desc limit 200`,
  );
}

/** One of the user's own live-or-expired pastes WITH content, for the editor. */
export async function getOwnPaste(userId: string, slug: string): Promise<OwnPasteWithContent | null> {
  if (!SLUG_RE.test(slug)) return null;
  const rows = await withUser(
    userId,
    (tx) => tx<OwnPasteWithContent[]>`
      select slug, title, language, visibility, expires_at, deleted_at, created_at, updated_at, content
      from paste.pastes where slug = ${slug} and owner_id = auth.uid() and deleted_at is null`,
  );
  return rows[0] ?? null;
}

/** Owner-only edit. Throws ZodError on bad input, PasteNotFoundError if not the owner's live paste. */
export async function updatePasteFor(userId: string, input: UpdatePasteInput): Promise<OwnPasteWithContent> {
  const p = updatePasteSchema.parse(input);
  const changes: Record<string, unknown> = {};
  if (p.title !== undefined) changes.title = p.title;
  if (p.content !== undefined) changes.content = p.content;
  if (p.language !== undefined) changes.language = p.language;
  if (p.visibility !== undefined) changes.visibility = p.visibility;
  if (p.expiresAt !== undefined) changes.expires_at = p.expiresAt === null ? null : new Date(p.expiresAt);
  const cols = Object.keys(changes);
  return withUser(userId, async (tx) => {
    // Lock the row so the seam sees exactly what the update will change.
    const [cur] = await tx<(OwnPasteWithContent)[]>`
      select slug, title, language, visibility, expires_at, deleted_at, created_at, updated_at, content
      from paste.pastes where slug = ${p.slug} and owner_id = auth.uid() and deleted_at is null for update`;
    if (!cur) throw new PasteNotFoundError();
    if (cols.length === 0) return cur;
    await validateForPublish(tx, {
      userId,
      action: 'update',
      content: p.content ?? cur.content,
      contentChanged: p.content !== undefined && p.content !== cur.content,
      visibility: p.visibility ?? cur.visibility,
      prevVisibility: cur.visibility,
      expiresAt: p.expiresAt === undefined ? cur.expires_at : p.expiresAt === null ? null : new Date(p.expiresAt),
      acknowledgeSecrets: p.acknowledgeSecrets,
      secretsFingerprint: p.secretsFingerprint,
    });
    const [row] = await tx<OwnPasteWithContent[]>`
      update paste.pastes set ${tx(changes as never, ...cols)}
      where slug = ${p.slug} and owner_id = auth.uid() and deleted_at is null
      returning slug, title, language, visibility, expires_at, deleted_at, created_at, updated_at, content`;
    await logActivity(tx, { action: 'paste.update', entityType: 'paste', entityId: p.slug, meta: { fields: cols } });
    return row;
  });
}

/** Owner-only soft delete (sets deleted_at). Throws PasteNotFoundError otherwise. */
export async function deletePasteFor(userId: string, slug: string): Promise<void> {
  if (!SLUG_RE.test(slug)) throw new PasteNotFoundError();
  await withUser(userId, async (tx) => {
    const rows = await tx`
      update paste.pastes set deleted_at = now()
      where slug = ${slug} and owner_id = auth.uid() and deleted_at is null returning slug`;
    if (rows.length === 0) throw new PasteNotFoundError();
    await logActivity(tx, { action: 'paste.delete', entityType: 'paste', entityId: slug });
  });
}
