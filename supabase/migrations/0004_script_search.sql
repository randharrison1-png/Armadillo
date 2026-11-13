-- 0004_script_search: substring search over script code.
--
-- Code tokens such as `Set-NetFirewallProfile` tokenize poorly under to_tsvector('english'), so the
-- library searches with ILIKE '%term%' and a trigram GIN index (pg_trgm) on the version content.
-- The query joins scripts to their CURRENT version, so only that version's content is searched.
-- name / filename / description are small and scanned directly.
--
-- pg_trgm lives in the `extensions` schema (Supabase's convention). The ILIKE operator and the index
-- operator class resolve at index-definition time, so queries need no search_path change.

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

create index script_versions_content_trgm_idx
  on public.script_versions using gin (content extensions.gin_trgm_ops);
