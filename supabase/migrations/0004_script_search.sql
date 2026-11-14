-- 0004_script_search: substring search over script code.
--
-- Code tokens such as `Set-NetFirewallProfile` tokenize poorly under to_tsvector('english'), so the
-- library searches with ILIKE '%term%' backed by trigram GIN indexes (pg_trgm) on the version
-- content and on scripts.name / filename / description. The query (see searchQuery in
-- src/features/library/service.ts) keeps each indexed predicate in its own UNION branch, so the
-- planner can use the matching index; only the current version's content is searched.
--
-- pg_trgm lives in the `extensions` schema (Supabase's convention). The ILIKE operator and the index
-- operator class resolve at index-definition time, so queries need no search_path change.

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

create index script_versions_content_trgm_idx
  on public.script_versions using gin (content extensions.gin_trgm_ops);
create index scripts_name_trgm_idx on public.scripts using gin (name extensions.gin_trgm_ops);
create index scripts_filename_trgm_idx on public.scripts using gin (filename extensions.gin_trgm_ops);
create index scripts_description_trgm_idx on public.scripts using gin (description extensions.gin_trgm_ops);
