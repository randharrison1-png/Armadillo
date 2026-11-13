-- 0001_profiles: per-user profile row, created by a trigger on auth.users.
-- Plain Supabase-compatible SQL: applies unchanged to a hosted project and to the local test shim.

-- Shared by profiles.default_os and (Task 4) sessions.os. Mirrors OsType in src/lib/types.ts.
create type public.os_type as enum ('windows', 'windows_server', 'linux');

-- Generic updated_at maintenance; reused by later tables.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 1 and 100),
  default_os public.os_type,
  -- Encrypted Claude API key. Never readable by the `authenticated` role (see column grants below);
  -- written and read only by server code running as service_role / a security-definer function.
  claude_key_ciphertext text,
  claude_key_last4 text check (claude_key_last4 is null or char_length(claude_key_last4) = 4),
  model text check (model is null or char_length(model) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.profiles.claude_key_ciphertext is
  'Encrypted Claude API key. Column privileges are revoked from anon/authenticated; never select it from client-scoped queries.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Row-level security: the owner can read and update their own row. No insert/delete policies:
-- rows are created by the auth trigger and removed by the auth.users cascade.
alter table public.profiles enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Column privileges. Supabase grants ALL on new public tables to anon/authenticated/service_role
-- by default; take that back and grant only what clients may touch. `select *` as authenticated
-- therefore fails: always name the columns.
revoke all on table public.profiles from anon, authenticated;
grant select (id, display_name, default_os, claude_key_last4, model, created_at, updated_at)
  on table public.profiles to authenticated;
-- The key columns (ciphertext + last4) are written together by server code, never by the client.
grant update (display_name, default_os, model) on table public.profiles to authenticated;
grant all on table public.profiles to service_role;

-- Create the profile when an auth user is created (standard Supabase pattern).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

-- Trigger functions run regardless of EXECUTE privilege; keep it off the API roles so it is never
-- exposed as an RPC.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
