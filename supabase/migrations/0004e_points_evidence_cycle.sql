-- 0004e_points_evidence_cycle: points per audit cycle and the cycle of each piece of evidence (Task 18).
--
-- remediation_cycles.points / target_points  the point count the user read off the competition scoring
--     page ("Check final points") and, optionally, the target. Self-reported: never treated as
--     verification. Null until recorded.
-- evidence.cycle_no  the session's current_cycle when the evidence was attached. The "Complete and
--     Verified needs evidence" guard (setStepStatusTx) counts evidence of the CURRENT cycle only, so
--     evidence of cycle 1 never verifies a step again in cycle 2.
--     addEvidence sets it under the session lock; the trigger below fills it from the session for any
--     insert that leaves it null, so the column is never null and never guessed.

alter table public.remediation_cycles
  add column points numeric,
  add column target_points numeric;

alter table public.remediation_cycles
  add constraint remediation_cycles_points_range check (points is null or (points >= 0 and points <= 10000)),
  add constraint remediation_cycles_target_range check (target_points is null or (target_points >= 0 and target_points <= 10000));

alter table public.evidence add column cycle_no integer;

-- Backfill: the cycle of the session's latest step event at or before the evidence, else cycle 1.
update public.evidence e
set cycle_no = coalesce(
  (select ev.cycle_no from public.workflow_step_events ev
   where ev.session_id = e.session_id and ev.created_at <= e.created_at
   order by ev.created_at desc, ev.id desc limit 1),
  1);

alter table public.evidence
  alter column cycle_no set not null,
  add constraint evidence_cycle_no_positive check (cycle_no >= 1);

create or replace function public.evidence_default_cycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.cycle_no is null then
    select s.current_cycle into new.cycle_no from public.sessions s
    where s.id = new.session_id and s.owner_id = new.owner_id;
    -- No visible session of the owner: leave the refusal to the foreign key (never a NOT NULL error).
    new.cycle_no := coalesce(new.cycle_no, 1);
  end if;
  return new;
end;
$$;

create trigger evidence_default_cycle before insert on public.evidence
  for each row execute function public.evidence_default_cycle();

create index evidence_session_cycle_idx on public.evidence (session_id, cycle_no, step);
