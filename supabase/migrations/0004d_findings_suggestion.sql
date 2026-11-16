-- 0004d_findings_suggestion: Claude's suggested requirement for a LEADS finding (Task 17).
--
-- suggested_requirement_id  the requirement Claude thinks the finding checks (mapFindingsToRequirements).
--                           Only a suggestion: the user confirms it in the report tab, which writes
--                           requirement_id. Verification (applyVerification) reads requirement_id only,
--                           never the suggestion. Cleared (not the finding) if the requirement is deleted.
--
-- Both requirement columns must point at a requirement of the finding's own session. The composite
-- foreign keys only pin the owner (leads_findings has no session_id), so a trigger checks the session
-- through the report, on every insert and on updates of either column (or of report_id).

alter table public.leads_findings
  add column suggested_requirement_id uuid;

alter table public.leads_findings
  add constraint leads_findings_suggested_requirement_fkey foreign key (suggested_requirement_id, owner_id)
    references public.requirements (id, owner_id) on delete set null (suggested_requirement_id);

create index leads_findings_suggested_requirement_idx on public.leads_findings (suggested_requirement_id);

create or replace function public.assert_finding_requirement_same_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
begin
  foreach rid in array array[new.requirement_id, new.suggested_requirement_id] loop
    -- Only the owner's own rows are consulted: a requirement or report of another owner is left to
    -- the composite foreign keys (23503), so nothing about another user's rows is revealed here.
    if rid is not null
      and exists (
        select 1 from public.requirements q
        join public.leads_reports r on r.owner_id = q.owner_id
        where q.id = rid and r.id = new.report_id and q.owner_id = new.owner_id and r.session_id <> q.session_id)
    then
      raise exception 'requirement is not part of this finding''s session'
        using errcode = '23514', hint = 'A finding can only be mapped to a requirement of the same session.';
    end if;
  end loop;
  return new;
end;
$$;

create trigger leads_findings_requirement_same_session
  before insert or update of requirement_id, suggested_requirement_id, report_id on public.leads_findings
  for each row execute function public.assert_finding_requirement_same_session();

revoke execute on function public.assert_finding_requirement_same_session() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Remediation proposals know their audit cycle and report (Task 17 review).
--
-- cycle_no   the session's current_cycle when the remediation was proposed. Accepting is refused once
--            the session has moved to another cycle, and the script is named after this cycle.
-- report_id  the LEADS report (same session, which must be of cycle_no) the remediation answers.
-- Both null for adaptations. NO ACTION: the report behind a proposal cannot vanish (reports go only
-- with their session, which cascades).
-- ---------------------------------------------------------------------------------------------------
alter table public.proposals
  add column cycle_no integer check (cycle_no is null or cycle_no >= 1),
  add column report_id uuid;

alter table public.proposals
  add constraint proposals_report_fkey foreign key (report_id, session_id)
    references public.leads_reports (id, session_id),
  add constraint proposals_cycle_only_for_remediation check (kind = 'remediation' or (cycle_no is null and report_id is null));

create index proposals_report_idx on public.proposals (report_id);
create index proposals_session_cycle_idx on public.proposals (session_id, cycle_no) where kind = 'remediation';
