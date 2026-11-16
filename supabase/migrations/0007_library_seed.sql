-- 0007_library_seed: shared starter scripts that every account gets in its own library.
--
-- The scripts themselves live in supabase/seed/library/ (manifest.json + the files, stored byte for
-- byte) and are loaded into library_seed.scripts by scripts/load-library-seed.mjs. This migration only
-- creates the table and the copy mechanism, so it applies cleanly to an empty database.
--
-- Each account gets its OWN copy (a normal universal script at version 1), so the app's ownership
-- rules, RLS and version history apply unchanged. A copy is made:
--   * for every new account, when its profile row is created (trigger below), and
--   * for existing accounts, by calling library_seed.copy_to_all() after loading or adding seeds.
-- An account that already has a universal script with the same filename is skipped for that file, so
-- running the copy again never duplicates and never overwrites anything the user changed.

create schema library_seed;
revoke all on schema library_seed from public, anon, authenticated;

create table library_seed.scripts (
  filename text primary key check (char_length(filename) between 1 and 255),
  name text not null check (char_length(name) between 1 and 200),
  category public.script_category not null,
  function public.script_function not null,
  description text,
  os_compat public.os_type[] not null default '{}',
  content text not null,
  encoding public.text_encoding not null default 'utf-8',
  line_ending text not null check (line_ending in ('crlf', 'lf', 'mixed')),
  language public.script_language not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);
revoke all on table library_seed.scripts from public, anon, authenticated;

-- Copies every seed script the account does not have yet. Returns how many were copied.
create function library_seed.copy_to_user(p_owner uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  v_script uuid;
  v_version uuid;
  n integer := 0;
begin
  if not exists (select 1 from auth.users u where u.id = p_owner) then
    return 0;
  end if;
  for s in select * from library_seed.scripts order by filename loop
    if exists (
      select 1 from public.scripts x
      where x.owner_id = p_owner and x.session_id is null and x.filename = s.filename
    ) then
      continue;
    end if;
    insert into public.scripts (owner_id, name, filename, category, function, description, os_compat)
    values (p_owner, s.name, s.filename, s.category, s.function, s.description, s.os_compat)
    returning id into v_script;
    insert into public.script_versions
      (owner_id, script_id, version_no, content, encoding, line_ending, language, sha256, author, change_note)
    values (p_owner, v_script, 1, s.content, s.encoding, s.line_ending, s.language, s.sha256, 'user',
            'Added from the shared library')
    returning id into v_version;
    update public.scripts set current_version_id = v_version where id = v_script;
    insert into public.activity_log (owner_id, action, entity_type, entity_id, meta)
    values (p_owner, 'script.seed', 'script', v_script::text,
            jsonb_build_object('name', s.name, 'filename', s.filename, 'versionId', v_version));
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Copies the seed scripts to every existing account. Returns how many scripts were copied in all.
create function library_seed.copy_to_all()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  total integer := 0;
  p record;
begin
  for p in select id from public.profiles loop
    total := total + library_seed.copy_to_user(p.id);
  end loop;
  return total;
end;
$$;

create function library_seed.on_profile_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform library_seed.copy_to_user(new.id);
  return new;
end;
$$;

revoke execute on function library_seed.copy_to_user(uuid) from public, anon, authenticated;
revoke execute on function library_seed.copy_to_all() from public, anon, authenticated;
revoke execute on function library_seed.on_profile_created() from public, anon, authenticated;

create trigger profiles_copy_library_seed
  after insert on public.profiles
  for each row execute function library_seed.on_profile_created();
