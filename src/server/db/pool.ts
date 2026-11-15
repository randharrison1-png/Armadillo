import 'server-only';
import postgres from 'postgres';

export type Sql = postgres.Sql;

// Survives Next dev hot reloads, which re-evaluate modules but keep globalThis.
const globalForPool = globalThis as typeof globalThis & { __armadilloPool?: Sql };

/**
 * Lazily created postgres.js pool for DATABASE_URL.
 * `prepare: false` keeps it compatible with the Supabase transaction pooler (no named prepared
 * statements survive across pooled connections).
 * Do not query with this directly from feature code: go through withUser / withAnon so RLS applies.
 */
export function getPool(): Sql {
  if (!globalForPool.__armadilloPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    globalForPool.__armadilloPool = postgres(url, {
      prepare: false,
      max: Number(process.env.DATABASE_POOL_MAX?.trim() || 5),
      idle_timeout: 20,
      onnotice: () => {},
    });
  }
  return globalForPool.__armadilloPool;
}

/** Closes the pool (tests and graceful shutdown). The next getPool() call opens a new one. */
export async function closePool(): Promise<void> {
  const pool = globalForPool.__armadilloPool;
  globalForPool.__armadilloPool = undefined;
  await pool?.end({ timeout: 5 });
}
