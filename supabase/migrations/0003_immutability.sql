-- 0003_immutability: data that must not change once written.
--
-- 1. Insert-only tables (script_versions, workflow_step_events, activity_log): UPDATE, DELETE and
--    TRUNCATE raise for every role, including service_role and the table owner. (authenticated is
--    already refused earlier by privileges, see 0002.)
-- 2. Completed sessions are read-only: INSERT/UPDATE/DELETE on a session's child rows raise once
--    sessions.status = 'completed'. activity_log is exempt (logging still works); the sessions row
--    itself is not covered here.
--
-- Account deletion: deleting the auth.users row must still remove everything (ON DELETE CASCADE from
-- auth.users; Task 21). Both triggers therefore let a row through when its owner's auth user no
-- longer exists, which is only true inside that cascade: a live user can never own rows whose
-- owner_id is missing from auth.users (owner_id references auth.users). No role or session setting is
-- trusted for this, so it holds however the auth user is deleted (Auth admin API, SQL, service_role).
-- Consequence: a script with versions, or a session with any insert-only rows, cannot be deleted on
-- its own; universal scripts are archived (scripts.archived_at) instead.

create or replace function public.forbid_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_level = 'ROW' then
    if not exists (select 1 from auth.users u where u.id = old.owner_id) then
      -- The owner's auth user is gone: this is the account-deletion cascade.
      if tg_op = 'DELETE' then
        return old;
      end if;
      return new;
    end if;
  end if;
  raise exception '%.% is insert-only', tg_table_schema, tg_table_name
    using errcode = '55000', hint = 'Insert a new row instead of changing or removing this one.';
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['script_versions', 'workflow_step_events', 'activity_log'] loop
    execute format(
      'create trigger %I before update or delete on public.%I for each row execute function public.forbid_mutation()',
      t || '_forbid_mutation', t);
    execute format(
      'create trigger %I before truncate on public.%I for each statement execute function public.forbid_mutation()',
      t || '_forbid_truncate', t);
  end loop;
end
$$;

-- Raises if the row (before or after the change) belongs to a completed session of the same owner.
-- Rows that reach their session indirectly look it up through their parent:
--   messages → conversations, leads_findings → leads_reports, script_versions → scripts.
-- A universal script (session_id null) and its versions are never affected.
-- Only sessions of the row's own owner are consulted, so the error can never reveal anything about
-- another user's session (such inserts fail on the composite foreign keys instead).
create or replace function public.assert_session_writable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rec jsonb;
  owner uuid;
  sid uuid;
  recs jsonb[];
begin
  recs := case tg_op
    when 'INSERT' then array[to_jsonb(new)]
    when 'DELETE' then array[to_jsonb(old)]
    else array[to_jsonb(old), to_jsonb(new)]
  end;

  foreach rec in array recs loop
    owner := (rec ->> 'owner_id')::uuid;
    sid := case tg_table_name
      when 'messages' then (
        select c.session_id from public.conversations c
        where c.id = (rec ->> 'conversation_id')::uuid and c.owner_id = owner)
      when 'leads_findings' then (
        select r.session_id from public.leads_reports r
        where r.id = (rec ->> 'report_id')::uuid and r.owner_id = owner)
      when 'script_versions' then (
        select s.session_id from public.scripts s
        where s.id = (rec ->> 'script_id')::uuid and s.owner_id = owner)
      else (rec ->> 'session_id')::uuid
    end;

    if sid is not null
      and exists (
        select 1 from public.sessions s
        where s.id = sid and s.owner_id = owner and s.status = 'completed')
      -- Account-deletion cascade (see header).
      and exists (select 1 from auth.users u where u.id = owner)
    then
      raise exception 'session % is completed and read-only', sid
        using errcode = '55000', hint = 'Completed sessions can be viewed but not changed.';
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'scripts', 'script_versions', 'readmes', 'conversations', 'messages', 'leads_reports', 'requirements',
    'leads_findings', 'proposals', 'evidence', 'remediation_cycles', 'workflow_steps',
    'workflow_step_events', 'forensic_questions'
  ] loop
    execute format(
      'create trigger %I before insert or update or delete on public.%I '
      'for each row execute function public.assert_session_writable()',
      t || '_assert_session_writable', t);
  end loop;
end
$$;

-- Trigger functions run regardless of EXECUTE privilege; keep them off the API roles (no RPC).
revoke execute on function public.forbid_mutation() from public, anon, authenticated;
revoke execute on function public.assert_session_writable() from public, anon, authenticated;
