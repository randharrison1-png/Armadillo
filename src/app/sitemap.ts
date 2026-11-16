import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/siteUrl';
import { withAnon } from '@/server/db/withUser';

// Reads the database: never prerender at build time.
export const dynamic = 'force-dynamic';

/** /p plus live PUBLIC pastes (never unlisted), newest first, capped at 1000. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const rows = await withAnon(
    (tx) => tx<{ slug: string; updated_at: Date }[]>`
      select slug, updated_at from paste.pastes
      where visibility = 'public' and (expires_at is null or expires_at > now())
      order by created_at desc limit 1000`,
  );
  return [{ url: `${base}/p` }, ...rows.map((r) => ({ url: `${base}/p/${r.slug}`, lastModified: r.updated_at }))];
}
