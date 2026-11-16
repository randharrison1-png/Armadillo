-- Task 6: transactional session creation.
-- Named 0003b so it applies after 0003_immutability and before 0004 (script search).
--
-- SECURITY INVOKER: runs as the caller, so RLS applies and owner_id defaults to auth.uid(). The
-- session, its nine workflow_steps rows (all at not_started, in flowchart order) and the activity
-- entry are written in one statement-level transaction: any failure rolls back all of them.
create or replace function public.create_session(p_title text, p_os public.os_type)
returns public.sessions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_title text := btrim(p_title);
  v_session public.sessions;
begin
  if (select auth.uid()) is null then
    raise exception 'create_session requires an authenticated user' using errcode = '28000';
  end if;
  if v_title is null or char_length(v_title) < 1 or char_length(v_title) > 120 then
    raise exception 'session title must be 1 to 120 characters' using errcode = '22023';
  end if;

  insert into public.sessions (title, os) values (v_title, p_os) returning * into v_session;

  -- enum_range yields the step_key labels in declaration (= flowchart) order.
  insert into public.workflow_steps (session_id, step, status)
  select v_session.id, s, 'not_started'
  from unnest(enum_range(null::public.step_key)) as s;

  insert into public.activity_log (session_id, action, entity_type, entity_id, meta)
  values (
    v_session.id, 'session.created', 'session', v_session.id::text,
    jsonb_build_object('title', v_session.title, 'os', v_session.os)
  );

  return v_session;
end;
$$;

revoke execute on function public.create_session(text, public.os_type) from public, anon;
grant execute on function public.create_session(text, public.os_type) to authenticated, service_role;

-- A change to a step counts as activity on its session: dashboard/sidebar order by sessions.updated_at.
-- SECURITY INVOKER (RLS applies). Only active sessions are touched: a completed session's row is
-- immutable (and writes to its steps are already refused).
create or replace function public.touch_session_on_step_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.sessions set updated_at = now() where id = new.session_id and status = 'active';
  return new;
end;
$$;

create trigger workflow_steps_touch_session
  after update on public.workflow_steps
  for each row execute function public.touch_session_on_step_change();

revoke execute on function public.touch_session_on_step_change() from public, anon, authenticated;
