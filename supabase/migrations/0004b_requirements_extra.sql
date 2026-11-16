-- 0004b_requirements_extra: what Claude adds to a requirement (Task 13).
--
-- category     the requirement's area, as Claude classified it at extraction (accounts, services, …).
-- suggestion   Claude's suggested script change (or, for a disruptive requirement, what to review)
--              from the last coverage assessment (spec §5.3: "Missing from selected script →
--              suggest a modification").
-- reviewed_at  when the user explicitly reviewed a potentially disruptive requirement ("Mark
--              reviewed"; spec §5.3: "Potentially disruptive → require explicit review"). Until then a
--              disruptive requirement cannot move to reported (statusMachine.ts). Set by the user only.
--
-- category and suggestion are Claude's output, kept apart from `notes`, which belongs to the user.
-- Nullable: rows created before this migration, and rows Claude did not classify, have none.

alter table public.requirements
  add column category text,
  add column suggestion text,
  add column reviewed_at timestamptz;

alter table public.requirements
  add constraint requirements_category_length check (category is null or char_length(category) <= 64),
  add constraint requirements_suggestion_length check (suggestion is null or char_length(suggestion) <= 4000),
  add constraint requirements_text_length check (char_length(text) between 1 and 2000),
  add constraint requirements_notes_length check (notes is null or char_length(notes) <= 4000);
