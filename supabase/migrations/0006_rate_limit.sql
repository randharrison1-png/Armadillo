-- Fixed-window rate limiting, used by publishing (10 publishes/hour/user, 60 other edits/hour/user)
-- and abuse reports (5/hour per reporter hash).
--
-- rate_limit_hits is private: RLS on, no policies, every privilege revoked from the API roles. The
-- only way in is check_rate_limit(), which is SECURITY DEFINER with an empty search_path.

create table public.rate_limit_hits (
  key text not null check (char_length(key) <= 200),
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);
create index rate_limit_hits_window_idx on public.rate_limit_hits (window_start);

alter table public.rate_limit_hits enable row level security;
alter table public.rate_limit_hits force row level security;
-- Default privileges grant API roles everything on new tables (as on hosted Supabase): take it back.
revoke all on public.rate_limit_hits from public, anon, authenticated, service_role;

/*
 * Counts one hit for p_key in the current fixed window (windows are aligned to the epoch) and says
 * whether it is within p_limit. When not ok, retry_after is the whole seconds until the window
 * ends (at least 1). Old windows are deleted opportunistically (about 1 call in 20).
 *
 * Callers may only spend their own budget, so a client with direct RPC access cannot exhaust
 * someone else's quota: `publish:` and `edit:` keys must carry the caller's auth.uid(); `report:`
 * keys carry an opaque server-computed hash.
 */
create function public.check_rate_limit(p_key text, p_limit int, p_window_seconds int)
returns table (ok boolean, retry_after int)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_count int;
  v_uid text := auth.uid()::text;
begin
  if p_key is null or char_length(p_key) > 200 then
    raise exception 'check_rate_limit: invalid key' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'check_rate_limit: invalid limit or window' using errcode = '22023';
  end if;
  if not (
    (v_uid is not null and p_key in ('publish:' || v_uid, 'edit:' || v_uid))
    or (p_key like 'report:%' and char_length(p_key) > 7)
  ) then
    raise exception 'check_rate_limit: key not allowed' using errcode = '42501';
  end if;

  v_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limit_hits as h (key, window_start, count)
  values (p_key, v_start, 1)
  on conflict (key, window_start) do update set count = h.count + 1
  returning h.count into v_count;

  if random() < 0.05 then
    delete from public.rate_limit_hits where window_start < now() - interval '1 day';
  end if;

  ok := v_count <= p_limit;
  retry_after := case
    when ok then 0
    else greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => p_window_seconds) - clock_timestamp())))::int)
  end;
  return next;
end
$$;

revoke all on function public.check_rate_limit(text, int, int) from public, anon, authenticated, service_role;
grant execute on function public.check_rate_limit(text, int, int) to anon, authenticated;
