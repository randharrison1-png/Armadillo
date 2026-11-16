/** Absolute origin for sitemap/robots. Set SITE_URL in production. */
export function siteUrl(): string {
  return (process.env.SITE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
}
