-- 0004b_requirements_extra: what Claude adds to a requirement (Task 13).
--
-- category    the requirement's area, as Claude classified it at extraction (accounts, services, …).
-- suggestion  Claude's suggested script change from the last coverage assessment (spec §5.3:
--             "Missing from selected script → suggest a modification").
--
-- Both are Claude's output, kept apart from `notes`, which belongs to the user. Nullable: rows
-- created before this migration, and rows Claude did not classify, have none.

alter table public.requirements
  add column category text,
  add column suggestion text;

alter table public.requirements
  add constraint requirements_category_length check (category is null or char_length(category) <= 64),
  add constraint requirements_suggestion_length check (suggestion is null or char_length(suggestion) <= 4000),
  add constraint requirements_text_length check (char_length(text) between 1 and 2000),
  add constraint requirements_notes_length check (notes is null or char_length(notes) <= 4000);
