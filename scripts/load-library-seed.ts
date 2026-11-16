/**
 * Loads the shared starter scripts (supabase/seed/library) into library_seed.scripts and copies them
 * into every existing account's library (migration 0007). New accounts get them automatically.
 *
 *   DATABASE_URL=postgresql://postgres:...@host:5432/postgres pnpm tsx scripts/load-library-seed.ts
 *
 * Connect as the `postgres` role (direct or session pooler). Safe to run again: seeds are upserted by
 * filename, and an account that already has a universal script with that filename is skipped.
 * Pass --no-copy to load the seeds without copying them to existing accounts.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { decodeText } from '../src/server/files/encoding';
import { languageFor } from '../src/features/library/scriptMeta';

type Seed = {
  filename: string;
  name: string;
  category: string;
  function: string;
  os_compat: string[];
  description?: string;
};

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'supabase', 'seed', 'library');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const copy = !process.argv.includes('--no-copy');
const seeds = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Seed[];
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

try {
  for (const s of seeds) {
    const decoded = decodeText(new Uint8Array(readFileSync(path.join(dir, s.filename))));
    const sha256 = createHash('sha256').update(decoded.text, 'utf8').digest('hex');
    await sql`
      insert into library_seed.scripts
        (filename, name, category, function, description, os_compat, content, encoding, line_ending, language, sha256)
      values (${s.filename}, ${s.name}, ${s.category}::public.script_category, ${s.function}::public.script_function,
              ${s.description ?? null}, ${s.os_compat}::public.os_type[], ${decoded.text},
              ${decoded.encoding}::public.text_encoding, ${decoded.lineEnding},
              ${languageFor(s.filename)}::public.script_language, ${sha256})
      on conflict (filename) do update set
        name = excluded.name, category = excluded.category, function = excluded.function,
        description = excluded.description, os_compat = excluded.os_compat, content = excluded.content,
        encoding = excluded.encoding, line_ending = excluded.line_ending, language = excluded.language,
        sha256 = excluded.sha256, updated_at = now()`;
    console.log(`seed ${s.filename}: ${decoded.encoding}, ${decoded.lineEnding}, sha256 ${sha256.slice(0, 12)}`);
  }
  if (copy) {
    const [row] = await sql<{ n: number }[]>`select library_seed.copy_to_all() as n`;
    console.log(`copied ${row!.n} script(s) into existing accounts`);
  }
} finally {
  await sql.end();
}
