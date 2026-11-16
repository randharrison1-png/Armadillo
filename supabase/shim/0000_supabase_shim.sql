-- Local stand-in for what Supabase provides (roles, auth schema, auth.uid()/auth.jwt()).
-- Used ONLY by the test database; never applied to a hosted Supabase project.

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

-- Lets the connecting superuser `set role` to each of them.
grant anon, authenticated, service_role to postgres;

-- Same defaults as hosted Supabase: the API roles can use public and get all privileges on new
-- objects there, so access is gated by RLS and explicit revokes, as in production.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;

-- Account deletion (Task 21) removes the user with a plain `delete from auth.users` as service_role
-- in the test environment (hosted Supabase uses the Auth admin API instead).
grant select, delete on auth.users to service_role;
