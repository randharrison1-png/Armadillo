-- Public pastebin datastore. A separate schema and permission boundary from the private workspace:
--  * no private (public.*) table references or is referenced by paste.* (owner_id -> auth.users is
--    the only foreign key, and cascades so deleting an account removes its pastes);
--  * default privileges do NOT cover this schema, so every grant below is explicit and minimal;
--  * keep `paste` OUT of any PostgREST "exposed schemas" setting: the app reaches it only through
--    server-side SQL (withAnon / withUser), and anon can read unlisted pastes by slug.

create schema paste;
revoke all on schema paste from public;
grant usage on schema paste to anon, authenticated;

create table paste.pastes (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[A-Za-z0-9_-]{10}$'),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text check (char_length(title) <= 200),
  content text not null check (octet_length(content) <= 524288),
  language text not null check (language in ('powershell', 'bash', 'batch', 'text', 'markdown')),
  visibility text not null default 'public' check (visibility in ('public', 'unlisted')),
  expires_at timestamptz,
  deleted_at timestamptz,
  -- true when the content was taken from a private workspace resource (confirmed by the user at publish).
  from_private boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pastes_public_listing_idx on paste.pastes (created_at desc) where visibility = 'public' and deleted_at is null;
create index pastes_owner_idx on paste.pastes (owner_id, created_at desc);

create function paste.touch_updated_at() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end
$$;
create trigger pastes_touch_updated_at before update on paste.pastes for each row execute function paste.touch_updated_at();

create table paste.reports (
  id uuid primary key default gen_random_uuid(),
  -- no foreign key: a report must survive (and may target) a deleted or expired paste.
  paste_slug text not null check (char_length(paste_slug) between 1 and 64),
  reason text not null check (char_length(reason) between 1 and 2000),
  reporter_hash text not null check (char_length(reporter_hash) <= 200),
  created_at timestamptz not null default now()
);

alter table paste.pastes enable row level security;
alter table paste.pastes force row level security;
alter table paste.reports enable row level security;
alter table paste.reports force row level security;

-- Anyone may read live pastes (public AND unlisted: unlisted is reachable by slug; listing code
-- must filter visibility = 'public' itself).
create policy pastes_select_live on paste.pastes for select to anon, authenticated
  using (deleted_at is null and (expires_at is null or expires_at > now()));
-- Owners also see their own expired and deleted pastes ("My pastes").
create policy pastes_select_own on paste.pastes for select to authenticated
  using (owner_id = auth.uid());
create policy pastes_insert_own on paste.pastes for insert to authenticated
  with check (owner_id = auth.uid());
-- A deleted paste can no longer be updated, so an owner cannot un-delete it.
create policy pastes_update_own on paste.pastes for update to authenticated
  using (owner_id = auth.uid() and deleted_at is null)
  with check (owner_id = auth.uid());
create policy pastes_delete_own on paste.pastes for delete to authenticated
  using (owner_id = auth.uid());

create policy reports_insert on paste.reports for insert to anon, authenticated with check (true);

revoke all on all tables in schema paste from public, anon, authenticated, service_role;
-- anon never sees owner_id, deleted_at or from_private.
grant select (id, slug, title, content, language, visibility, expires_at, created_at, updated_at) on paste.pastes to anon;
grant select, insert, delete on paste.pastes to authenticated;
-- Owners may edit content fields and soft-delete; slug, owner and created_at are immutable.
grant update (title, content, language, visibility, expires_at, deleted_at, from_private) on paste.pastes to authenticated;
grant insert on paste.reports to anon, authenticated;
