-- 0004c_proposals_extra: what an adaptation proposal needs beyond 0002 (Task 14).
--
-- readme_id   the README the adaptation was written for (same session). Kept so the review can say
--             which README it answers and "Re-propose against the latest version" can reuse it.
--             Nullable: remediation proposals (Task 17) have none.
-- summary     bounded, like the other Claude-written texts.
--
-- Decided proposals are final: once a proposal is accepted or rejected, the row cannot be updated
-- (no double accept, no reopening, no rewriting what was accepted). Same account-deletion exemption
-- as 0003: rows go away with auth.users. Deleting a session still cascades (DELETE is not blocked).
-- One update IS allowed: the ON DELETE SET NULL actions of proposals_readme_fkey and
-- proposals_conversation_fkey, i.e. an update whose only changes are readme_id and/or
-- conversation_id becoming NULL. Deleting a README or conversation therefore keeps the decided
-- proposal (as 0002 documents) with that link cleared.

alter table public.proposals
  add column readme_id uuid;

alter table public.proposals
  add constraint proposals_readme_fkey foreign key (readme_id, session_id)
    references public.readmes (id, session_id) on delete set null (readme_id),
  add constraint proposals_summary_length check (char_length(summary) <= 4000);

create index proposals_readme_idx on public.proposals (readme_id);

create or replace function public.forbid_decided_proposal_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- FK SET NULL: nothing but readme_id / conversation_id changed, each kept or set to NULL.
  -- (updated_at is ignored: proposals_set_updated_at may already have run.)
  if (to_jsonb(new) - 'readme_id' - 'conversation_id' - 'updated_at') = (to_jsonb(old) - 'readme_id' - 'conversation_id' - 'updated_at')
     and (new.readme_id is null or new.readme_id is not distinct from old.readme_id)
     and (new.conversation_id is null or new.conversation_id is not distinct from old.conversation_id) then
    return new;
  end if;
  if old.status <> 'pending' and exists (select 1 from auth.users u where u.id = old.owner_id) then
    raise exception 'proposal % is already decided (%)', old.id, old.status
      using hint = 'Accepted and rejected proposals cannot be changed.';
  end if;
  return new;
end;
$$;

create trigger proposals_forbid_decided_change
  before update on public.proposals
  for each row execute function public.forbid_decided_proposal_change();

revoke execute on function public.forbid_decided_proposal_change() from public, anon, authenticated;
