-- 0002_core: every private table of the data model (spec §5 / plan §5) except profiles (0001),
-- rate_limit_hits (0006, Task 20) and paste.* (0005, Task 19).
-- Plain Supabase-compatible SQL (Postgres 15+: uses ON DELETE SET NULL (column)).
--
-- Conventions
--   * Every table: id uuid pk, owner_id uuid not null default auth.uid() → auth.users ON DELETE CASCADE,
--     RLS enabled with select/insert/update/delete policies `owner_id = (select auth.uid())`
--     (insert-only tables get select/insert only; see 0003_immutability.sql).
--   * Cross-ownership: every table has `unique (id, owner_id)` and every reference to another private
--     row is a COMPOSITE foreign key that includes owner_id, e.g. (session_id, owner_id) →
--     sessions (id, owner_id). Because RLS forces owner_id = auth.uid() on the child, the parent must
--     belong to the same user: a user cannot attach rows to another user's session/script/report even
--     when they know its id. References between two session-scoped rows go one step further and use
--     (x_id, session_id) → x (id, session_id), so they also cannot cross sessions.
--   * Closed sets that have a named TypeScript type in src/lib/types.ts are Postgres enums named after
--     that type (os_type, script_category, script_function, script_language, text_encoding, step_key,
--     step_status, coverage, work_state). Column-local sets (status, role, kind, mode, author,
--     line_ending, ...) are text + CHECK.
--   * ON DELETE: "containment" references (row lives inside its parent: session children, messages in
--     a conversation, versions of a script, findings of a report) CASCADE. "Provenance" references
--     (which version/report/proposal something came from) are NO ACTION, so the source cannot be
--     deleted out from under them; account deletion removes both sides in one statement, and NO ACTION
--     is checked at the end of that statement, so it never blocks it.

-- ---------------------------------------------------------------------------------------------------
-- Enums (mirror src/lib/types.ts)
-- ---------------------------------------------------------------------------------------------------
create type public.script_category as enum ('windows', 'windows_server', 'linux', 'leads_audit');
create type public.script_function as enum ('universal_hardening', 'leads_audit', 'session_generated');
create type public.script_language as enum ('powershell', 'bash', 'batch', 'text', 'markdown');
create type public.text_encoding as enum ('utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be');
create type public.step_key as enum (
  'open_readme', 'forensic_questions', 'claude_adaptation', 'run_hardening',
  'run_leads', 'inspect_leads', 'run_remediation', 'check_points', 'submit_final'
);
create type public.step_status as enum ('not_started', 'in_progress', 'verified', 'blocked');
create type public.coverage as enum ('detected', 'covered', 'missing', 'needs_review', 'manual');
create type public.work_state as enum ('proposed', 'reported', 'verified');

-- ---------------------------------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------------------------------
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  os public.os_type not null,
  status text not null default 'active' check (status in ('active', 'completed')),
  current_cycle integer not null default 1 check (current_cycle >= 1),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sessions_id_owner_key unique (id, owner_id),
  constraint sessions_completed_at_matches_status check ((status = 'completed') = (completed_at is not null))
);
create index sessions_owner_updated_idx on public.sessions (owner_id, updated_at desc);

-- ---------------------------------------------------------------------------------------------------
-- scripts / script_versions (mutually referencing; the scripts → script_versions FKs are added after
-- script_versions exists)
-- ---------------------------------------------------------------------------------------------------
create table public.scripts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  filename text not null check (char_length(filename) between 1 and 255),
  category public.script_category not null,
  function public.script_function not null,
  description text,
  os_compat public.os_type[] not null default '{}',
  -- null ⇒ universal library script; set ⇒ belongs to (and is deleted with) that session.
  session_id uuid,
  -- The universal version this session copy was forked from (provenance; NO ACTION).
  forked_from_version_id uuid,
  -- Latest version. Nullable because a script row is inserted before its first version.
  current_version_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scripts_id_owner_key unique (id, owner_id),
  constraint scripts_session_fkey foreign key (session_id, owner_id)
    references public.sessions (id, owner_id) on delete cascade
);
create index scripts_owner_updated_idx on public.scripts (owner_id, updated_at desc);
create index scripts_session_idx on public.scripts (session_id);
create index scripts_forked_from_idx on public.scripts (forked_from_version_id);
create index scripts_current_version_idx on public.scripts (current_version_id);

create table public.script_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  script_id uuid not null,
  version_no integer not null check (version_no >= 1),
  content text not null,
  encoding public.text_encoding not null,
  line_ending text not null check (line_ending in ('crlf', 'lf', 'mixed')),
  language public.script_language not null,
  -- Lowercase hex SHA-256 (64 chars), computed by the server.
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  author text not null check (author in ('user', 'claude')),
  change_note text,
  -- The version this one was edited from (may belong to another script of the same owner, e.g. the
  -- universal source of a fork). Provenance; NO ACTION.
  base_version_id uuid,
  created_at timestamptz not null default now(),
  constraint script_versions_script_version_no_key unique (script_id, version_no),
  constraint script_versions_id_owner_key unique (id, owner_id),
  constraint script_versions_id_script_key unique (id, script_id),
  constraint script_versions_script_fkey foreign key (script_id, owner_id)
    references public.scripts (id, owner_id) on delete cascade,
  constraint script_versions_base_version_fkey foreign key (base_version_id, owner_id)
    references public.script_versions (id, owner_id)
);
create index script_versions_owner_idx on public.script_versions (owner_id);
create index script_versions_base_version_idx on public.script_versions (base_version_id);

alter table public.scripts
  add constraint scripts_forked_from_version_fkey foreign key (forked_from_version_id, owner_id)
    references public.script_versions (id, owner_id),
  -- (current_version_id, id) → (id, script_id): the current version must be a version OF THIS script.
  add constraint scripts_current_version_fkey foreign key (current_version_id, id)
    references public.script_versions (id, script_id);

-- ---------------------------------------------------------------------------------------------------
-- readmes
-- ---------------------------------------------------------------------------------------------------
create table public.readmes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id uuid not null,
  source text not null check (source in ('paste', 'upload')),
  filename text,
  storage_path text,
  text text not null default '',
  -- Segment[] (src/lib/types.ts): paragraph or page segments.
  segments jsonb not null default '[]' check (jsonb_typeof(segments) = 'array'),
  has_text_layer boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint readmes_id_owner_key unique (id, owner_id),
  constraint readmes_id_session_key unique (id, session_id),
  constraint readmes_session_fkey foreign key (session_id, owner_id)
    references public.sessions (id, owner_id) on delete cascade
);
create index readmes_owner_idx on public.readmes (owner_id);
create index readmes_session_idx on public.readmes (session_id);

-- ---------------------------------------------------------------------------------------------------
-- conversations / messages
-- ---------------------------------------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id uuid not null,
  mode text not null check (mode in ('adaptation', 'remediation', 'general')),
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_id_owner_key unique (id, owner_id),
  constraint conversations_id_session_key unique (id, session_id),
  constraint conversations_session_fkey foreign key (session_id, owner_id)
    references public.sessions (id, owner_id) on delete cascade
);
create index conversations_owner_idx on public.conversations (owner_id);
create index conversations_session_idx on public.conversations (session_id, updated_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  conversation_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  -- ResourceRef[] (src/lib/types.ts): the resources explicitly selected for this message.
  refs jsonb not null default '[]' check (jsonb_typeof(refs) = 'array'),
  status text not null default 'complete' check (status in ('streaming', 'complete', 'error')),
  -- Idempotency key from the browser. Unique PER CONVERSATION; null allowed (e.g. assistant rows).
  client_request_id text check (client_request_id is null or char_length(client_request_id) between 1 and 200),
  model text,
  usage jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint messages_id_owner_key unique (id, owner_id),
  constraint messages_conversation_client_request_key unique (conversation_id, client_request_id),
  constraint messages_conversation_fkey foreign key (conversation_id, owner_id)
    references public.conversations (id, owner_id) on delete cascade
);
create index messages_owner_idx on public.messages (owner_id);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------------------------------
-- leads_reports
-- ---------------------------------------------------------------------------------------------------
create table public.leads_reports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id uuid not null,
  cycle_no integer not null check (cycle_no >= 1),
  filename text not null check (char_length(filename) between 1 and 255),
  storage_path text,
  raw_text text not null default '',
  parser text not null default 'raw',
  -- ParsedReport (src/features/reports/parsers).
  parsed jsonb not null default '{}' check (jsonb_typeof(parsed) = 'object'),
  score numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_reports_id_owner_key unique (id, owner_id),
  constraint leads_reports_id_session_key unique (id, session_id),
  constraint leads_reports_session_fkey foreign key (session_id, owner_id)
    references public.sessions (id, owner_id) on delete cascade
);
create index leads_reports_owner_idx on public.leads_reports (owner_id);
create index leads_reports_session_idx on public.leads_reports (session_id, cycle_no);

-- ---------------------------------------------------------------------------------------------------
-- requirements
-- ---------------------------------------------------------------------------------------------------
create table public.requirements (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id uuid not null,
  readme_id uuid not null,
  text text not null,
  -- Segment.id inside readmes.segments.
  segment_id text not null,
  coverage public.coverage not null default 'detected',
  work_state public.work_state not null default 'proposed',
  disruptive boolean not null default false,
  automatable boolean not null default true,
  script_version_id uuid,
  evidence_report_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint requirements_id_owner_key unique (id, owner_id),
  -- Audit accuracy (spec §5.3): never Verified without a verification report.
  constraint requirements_verified_requires_evidence
    check (work_state <> 'verified' or evidence_report_id is not null),
  constraint requirements_session_fkey foreign key (session_id, owner_id)
    references public.sessions (id, owner_id) on delete cascade,
  -- Extracted from this README of the same session; deleted with it.
  constraint requirements_readme_fkey foreign key (readme_id, session_id)
    references public.readmes (id, session_id) on delete cascade,
  -- May be a universal or a session script version of the same owner. Provenance; NO ACTION.
  constraint requirements_script_version_fkey foreign key (script_version_id, owner_id)
    references public.script_versions (id, owner_id),
  -- A report of the same session. NO ACTION: the evidence behind a verified requirement cannot vanish.
  constraint requirements_evidence_report_fkey foreign key (evidence_report_id, session_id)
    references public.leads_reports (id, session_id)
);
create index requirements_owner_idx on public.requirements (owner_id);
create index requirements_session_idx on public.requirements (session_id);
create index requirements_readme_idx on public.requirements (readme_id);
create index requirements_script_version_idx on public.requirements (script_version_id);
create index requirements_evidence_report_idx on public.requirements (evidence_report_id);

-- ---------------------------------------------------------------------------------------------------
-- leads_findings
-- ---------------------------------------------------------------------------------------------------
create table public.leads_findings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  report_id uuid not null,
  title text not null,
  status text not null check (status in ('pass', 'fail', 'unknown')),
  severity text,
  category text,
  -- Line number in leads_reports.raw_text (Finding.rawLine).
  raw_line integer not null check (raw_line >= 0),
  requirement_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_findings_id_owner_key unique (id, owner_id),
  constraint leads_findings_report_fkey foreign key (report_id, owner_id)
    references public.leads_reports (id, owner_id) on delete cascade,
  -- Mapping confirmed by the user; cleared (not the finding) if the requirement is deleted.
  constraint leads_findings_requirement_fkey foreign key (requirement_id, owner_id)
    references public.requirements (id, owner_id) on delete set null (requirement_id)
);
create index leads_findings_owner_idx on public.leads_findings (owner_id);
create index leads_findings_report_idx on public.leads_findings (report_id);
create index leads_findings_requirement_idx on public.leads_findings (requirement_id);

-- ---------------------------------------------------------------------------------------------------
-- proposals
-- ---------------------------------------------------------------------------------------------------
create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Conversation the proposal came from, if any (same session). Kept if the conversation is deleted.
  conversation_id uuid,
  session_id uuid not null,
  kind text not null check (kind in ('adaptation', 'remediation')),
  -- Version the proposal edits; null for a remediation that starts a new script (ruling R6).
  base_version_id uuid,
  proposed_content text not null,
  summary text not null default '',
  -- HighImpactFlag[] (src/lib/types.ts).
  flags jsonb not null default '[]' check (jsonb_typeof(flags) = 'array'),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  result_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint proposals_id_owner_key unique (id, owner_id),
  constraint proposals_id_session_key unique (id, session_id),
  constraint proposals_accepted_has_result check (status <> 'accepted' or result_version_id is not null),
  constraint proposals_session_fkey foreign key (session_id, owner_id)
    references public.sessions (id, owner_id) on delete cascade,
  constraint proposals_conversation_fkey foreign key (conversation_id, session_id)
    references public.conversations (id, session_id) on delete set null (conversation_id),
  constraint proposals_base_version_fkey foreign key (base_version_id, owner_id)
    references public.script_versions (id, owner_id),
  constraint proposals_result_version_fkey foreign key (result_version_id, owner_id)
    references public.script_versions (id, owner_id)
);
create index proposals_owner_idx on public.proposals (owner_id);
create index proposals_session_idx on public.proposals (session_id, created_at desc);
create index proposals_conversation_idx on public.proposals (conversation_id);
create index proposals_base_version_idx on public.proposals (base_version_id);
create index proposals_result_version_idx on public.proposals (result_version_id);

-- ---------------------------------------------------------------------------------------------------
-- evidence
-- ---------------------------------------------------------------------------------------------------
create table public.evidence (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id uuid not null,
  step public.step_key not null,
  kind text not null check (kind in ('execution_output', 'screenshot', 'verification', 'other')),
  storage_path text,
  script_version_id uuid,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint evidence_id_owner_key unique (id, owner_id),
  constraint evidence_session_fkey foreign key (session_id, owner_id)
    references public.sessions (id, owner_id) on delete cascade,
  constraint evidence_script_version_fkey foreign key (script_version_id, owner_id)
    references public.script_versions (id, owner_id)
);
create index evidence_owner_idx on public.evidence (owner_id);
create index evidence_session_idx on public.evidence (session_id, step);
create index evidence_script_version_idx on public.evidence (script_version_id);

-- ---------------------------------------------------------------------------------------------------
-- remediation_cycles
-- ---------------------------------------------------------------------------------------------------
create table public.remediation_cycles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id uuid not null,
  cycle_no integer not null check (cycle_no >= 1),
  -- Both null until the cycle's report is uploaded / its remediation proposed. Same session; NO ACTION.
  report_id uuid,
  proposal_id uuid,
  outcome text not null default 'open' check (outcome in ('open', 'completed', 'continued')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint remediation_cycles_id_owner_key unique (id, owner_id),
  constraint remediation_cycles_session_cycle_key unique (session_id, cycle_no),
  constraint remediation_cycles_session_fkey foreign key (session_id, owner_id)
    references public.sessions (id, owner_id) on delete cascade,
  constraint remediation_cycles_report_fkey foreign key (report_id, session_id)
    references public.leads_reports (id, session_id),
  constraint remediation_cycles_proposal_fkey foreign key (proposal_id, session_id)
    references public.proposals (id, session_id)
);
create index remediation_cycles_owner_idx on public.remediation_cycles (owner_id);
create index remediation_cycles_report_idx on public.remediation_cycles (report_id);
create index remediation_cycles_proposal_idx on public.remediation_cycles (proposal_id);

-- ---------------------------------------------------------------------------------------------------
-- workflow_steps / workflow_step_events
-- ---------------------------------------------------------------------------------------------------
create table public.workflow_steps (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id uuid not null,
  step public.step_key not null,
  status public.step_status not null default 'not_started',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflow_steps_id_owner_key unique (id, owner_id),
  constraint workflow_steps_session_step_key unique (session_id, step),
  constraint workflow_steps_session_fkey foreign key (session_id, owner_id)
    references public.sessions (id, owner_id) on delete cascade
);
create index workflow_steps_owner_idx on public.workflow_steps (owner_id);

create table public.workflow_step_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id uuid not null,
  step public.step_key not null,
  -- null for the first recorded status of a step.
  from_status public.step_status,
  to_status public.step_status not null,
  cycle_no integer not null default 1 check (cycle_no >= 1),
  note text,
  created_at timestamptz not null default now(),
  constraint workflow_step_events_id_owner_key unique (id, owner_id),
  constraint workflow_step_events_session_fkey foreign key (session_id, owner_id)
    references public.sessions (id, owner_id) on delete cascade
);
create index workflow_step_events_owner_idx on public.workflow_step_events (owner_id);
create index workflow_step_events_session_idx on public.workflow_step_events (session_id, created_at);

-- ---------------------------------------------------------------------------------------------------
-- forensic_questions
-- ---------------------------------------------------------------------------------------------------
create table public.forensic_questions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id uuid not null,
  prompt text not null check (char_length(prompt) >= 1),
  answer text,
  status text not null default 'open' check (status in ('open', 'answered')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint forensic_questions_id_owner_key unique (id, owner_id),
  constraint forensic_questions_answered_has_answer check (status <> 'answered' or answer is not null),
  constraint forensic_questions_session_fkey foreign key (session_id, owner_id)
    references public.sessions (id, owner_id) on delete cascade
);
create index forensic_questions_owner_idx on public.forensic_questions (owner_id);
create index forensic_questions_session_idx on public.forensic_questions (session_id, created_at);

-- ---------------------------------------------------------------------------------------------------
-- activity_log
-- ---------------------------------------------------------------------------------------------------
create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id uuid,
  action text not null check (char_length(action) between 1 and 100),
  entity_type text not null check (char_length(entity_type) between 1 and 100),
  -- text, not uuid: some entities are keyed by other ids (e.g. paste slugs).
  entity_id text not null,
  meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object'),
  created_at timestamptz not null default now(),
  constraint activity_log_id_owner_key unique (id, owner_id),
  constraint activity_log_session_fkey foreign key (session_id, owner_id)
    references public.sessions (id, owner_id) on delete cascade
);
create index activity_log_owner_created_idx on public.activity_log (owner_id, created_at desc);
create index activity_log_session_idx on public.activity_log (session_id, created_at desc);

-- ---------------------------------------------------------------------------------------------------
-- updated_at maintenance (set_updated_at() from 0001). Insert-only tables have no updated_at.
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'sessions', 'scripts', 'readmes', 'conversations', 'messages', 'leads_reports', 'requirements',
    'leads_findings', 'proposals', 'evidence', 'remediation_cycles', 'workflow_steps', 'forensic_questions'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      t || '_set_updated_at', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------------------------------
-- Policies are `to authenticated` only. anon gets no privileges at all on private tables (Supabase's
-- default grants give it ALL), and TRUNCATE/REFERENCES/TRIGGER are taken back from authenticated
-- because TRUNCATE ignores RLS. Insert-only tables also lose UPDATE/DELETE here and get no update/
-- delete policies; their triggers (which also bind service_role) are in 0003_immutability.sql.
do $$
declare
  t text;
  insert_only constant text[] := array['script_versions', 'workflow_step_events', 'activity_log'];
begin
  foreach t in array array[
    'sessions', 'scripts', 'script_versions', 'readmes', 'conversations', 'messages', 'leads_reports',
    'requirements', 'leads_findings', 'proposals', 'evidence', 'remediation_cycles', 'workflow_steps',
    'workflow_step_events', 'forensic_questions', 'activity_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);

    execute format(
      'create policy %I on public.%I for select to authenticated using (owner_id = (select auth.uid()))',
      t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (owner_id = (select auth.uid()))',
      t || '_insert_own', t);

    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke truncate, references, trigger on table public.%I from authenticated', t);
    execute format('grant all on table public.%I to service_role', t);

    if t = any (insert_only) then
      execute format('revoke update, delete on table public.%I from authenticated', t);
    else
      execute format(
        'create policy %I on public.%I for update to authenticated '
        'using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()))',
        t || '_update_own', t);
      execute format(
        'create policy %I on public.%I for delete to authenticated using (owner_id = (select auth.uid()))',
        t || '_delete_own', t);
    end if;
  end loop;
end
$$;
