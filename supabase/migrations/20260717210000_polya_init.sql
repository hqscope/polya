-- ============================================================================
-- Polya v1 — initial schema.
-- Shared Canvascope Supabase project: every object is polya_-prefixed,
-- self-contained (FKs go to auth.users), and applied via MCP apply_migration
-- only (see CLAUDE.md hard rules). Additive-only after first apply.
-- ============================================================================

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- updated_at touch trigger shared by polya_ tables
-- ---------------------------------------------------------------------------
create or replace function public.polya_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Canvas connections — token vault table.
-- RLS enabled with ZERO policies and ZERO grants for anon/authenticated:
-- only service-role edge functions may touch it.
-- ---------------------------------------------------------------------------
create table if not exists public.polya_canvas_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  base_url text not null,
  access_token text not null,
  canvas_user_id text,
  canvas_user_name text,
  status text not null default 'active' check (status in ('active', 'invalid')),
  last_validated_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, base_url)
);

alter table public.polya_canvas_connections enable row level security;
revoke all on table public.polya_canvas_connections from anon, authenticated;

create trigger polya_canvas_connections_touch
  before update on public.polya_canvas_connections
  for each row execute function public.polya_set_updated_at();

-- ---------------------------------------------------------------------------
-- Courses
-- ---------------------------------------------------------------------------
create table if not exists public.polya_courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references public.polya_canvas_connections(id) on delete set null,
  canvas_course_id text not null,
  name text not null,
  code text,
  term_name text,
  import_status text not null default 'idle'
    check (import_status in ('idle', 'importing', 'complete', 'failed')),
  imported_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, canvas_course_id)
);

create index if not exists polya_courses_user_idx
  on public.polya_courses (user_id);

alter table public.polya_courses enable row level security;
revoke all on table public.polya_courses from anon, authenticated;
grant select on table public.polya_courses to authenticated;

create policy "polya_courses_select_own"
  on public.polya_courses for select
  to authenticated
  using ((select auth.uid()) = user_id);

create trigger polya_courses_touch
  before update on public.polya_courses
  for each row execute function public.polya_set_updated_at();

-- ---------------------------------------------------------------------------
-- Sources — one row per ingestable item; statuses drive the import pump.
-- ---------------------------------------------------------------------------
create table if not exists public.polya_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.polya_courses(id) on delete cascade,
  origin text not null check (origin in (
    'canvas_file', 'canvas_page', 'canvas_syllabus', 'canvas_assignment',
    'canvas_module_item', 'upload_transcript'
  )),
  source_kind text not null check (source_kind in (
    'pdf', 'html', 'transcript_txt', 'transcript_json', 'transcript_vtt', 'transcript_srt'
  )),
  canvas_id text,
  title text not null,
  module_name text,
  folder_path text,
  canvas_url text,
  storage_path text,
  content_sha256 text,
  size_bytes integer,
  page_count integer not null default 0,
  pages_parsed integer not null default 0,
  chunks_embedded integer not null default 0,
  content_role text not null default 'material'
    check (content_role in ('material', 'syllabus', 'assignment', 'solution_key')),
  status text not null default 'queued' check (status in (
    'queued', 'fetching', 'parsing', 'embedding', 'ready', 'failed', 'skipped', 'needs_ocr'
  )),
  error text,
  canvas_updated_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists polya_sources_canvas_identity_idx
  on public.polya_sources (user_id, course_id, origin, canvas_id)
  where canvas_id is not null;

create index if not exists polya_sources_course_status_idx
  on public.polya_sources (course_id, status);

alter table public.polya_sources enable row level security;
revoke all on table public.polya_sources from anon, authenticated;
grant select on table public.polya_sources to authenticated;

create policy "polya_sources_select_own"
  on public.polya_sources for select
  to authenticated
  using ((select auth.uid()) = user_id);

create trigger polya_sources_touch
  before update on public.polya_sources
  for each row execute function public.polya_set_updated_at();

-- ---------------------------------------------------------------------------
-- Procedures (numbered methods extracted from decks) + their steps
-- ---------------------------------------------------------------------------
create table if not exists public.polya_procedures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.polya_courses(id) on delete cascade,
  source_id uuid not null references public.polya_sources(id) on delete cascade,
  title text not null,
  page_start integer,
  page_end integer,
  step_count integer not null default 0,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists polya_procedures_source_idx
  on public.polya_procedures (source_id);

alter table public.polya_procedures enable row level security;
revoke all on table public.polya_procedures from anon, authenticated;
grant select on table public.polya_procedures to authenticated;

create policy "polya_procedures_select_own"
  on public.polya_procedures for select
  to authenticated
  using ((select auth.uid()) = user_id);

create table if not exists public.polya_procedure_steps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  procedure_id uuid not null references public.polya_procedures(id) on delete cascade,
  step_number integer not null,
  step_text text not null,
  page integer,
  unique (procedure_id, step_number)
);

alter table public.polya_procedure_steps enable row level security;
revoke all on table public.polya_procedure_steps from anon, authenticated;
grant select on table public.polya_procedure_steps to authenticated;

create policy "polya_procedure_steps_select_own"
  on public.polya_procedure_steps for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Content units — the retrieval corpus (chunks, procedure units, transcript
-- segments). Embeddings are 1536-dim, L2-normalized before insert.
-- ---------------------------------------------------------------------------
create table if not exists public.polya_content_units (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.polya_courses(id) on delete cascade,
  source_id uuid not null references public.polya_sources(id) on delete cascade,
  ordinal integer not null,
  unit_type text not null default 'chunk' check (unit_type in (
    'chunk', 'procedure', 'procedure_step', 'transcript_segment'
  )),
  content_role text not null default 'material'
    check (content_role in ('material', 'syllabus', 'assignment', 'solution_key')),
  heading_path text,
  page_start integer,
  page_end integer,
  t_start_ms integer,
  t_end_ms integer,
  procedure_id uuid references public.polya_procedures(id) on delete set null,
  step_number integer,
  content text not null,
  embedding extensions.vector(1536),
  embedding_model text,
  search_vector tsvector generated always as (
    to_tsvector('english', coalesce(heading_path, '') || ' ' || coalesce(content, ''))
  ) stored,
  created_at timestamptz not null default timezone('utc', now()),
  unique (source_id, ordinal)
);

create index if not exists polya_content_units_search_idx
  on public.polya_content_units using gin (search_vector);

create index if not exists polya_content_units_user_course_idx
  on public.polya_content_units (user_id, course_id);

create index if not exists polya_content_units_procedure_idx
  on public.polya_content_units (procedure_id)
  where procedure_id is not null;

alter table public.polya_content_units enable row level security;
revoke all on table public.polya_content_units from anon, authenticated;
grant select on table public.polya_content_units to authenticated;

create policy "polya_content_units_select_own"
  on public.polya_content_units for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Per-course assistance policy (instructor panel)
-- ---------------------------------------------------------------------------
create table if not exists public.polya_course_policies (
  course_id uuid primary key references public.polya_courses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null default 'guided' check (mode in ('open', 'guided', 'practice', 'review')),
  instructor_note text,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.polya_course_policies enable row level security;
revoke all on table public.polya_course_policies from anon, authenticated;
grant select, insert, update, delete on table public.polya_course_policies to authenticated;

create policy "polya_course_policies_select_own"
  on public.polya_course_policies for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "polya_course_policies_insert_own"
  on public.polya_course_policies for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "polya_course_policies_update_own"
  on public.polya_course_policies for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "polya_course_policies_delete_own"
  on public.polya_course_policies for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create trigger polya_course_policies_touch
  before update on public.polya_course_policies
  for each row execute function public.polya_set_updated_at();

-- ---------------------------------------------------------------------------
-- Conversations + messages
-- ---------------------------------------------------------------------------
create table if not exists public.polya_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.polya_courses(id) on delete cascade,
  title text,
  last_message_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists polya_conversations_user_course_recent_idx
  on public.polya_conversations (user_id, course_id, last_message_at desc);

alter table public.polya_conversations enable row level security;
revoke all on table public.polya_conversations from anon, authenticated;
grant select, insert, update, delete on table public.polya_conversations to authenticated;

create policy "polya_conversations_select_own"
  on public.polya_conversations for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "polya_conversations_insert_own"
  on public.polya_conversations for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "polya_conversations_update_own"
  on public.polya_conversations for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "polya_conversations_delete_own"
  on public.polya_conversations for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create table if not exists public.polya_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.polya_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  sources jsonb not null default '[]'::jsonb,
  help_level integer,
  policy_mode text,
  model text,
  usage jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists polya_messages_conversation_idx
  on public.polya_messages (conversation_id, created_at);

alter table public.polya_messages enable row level security;
revoke all on table public.polya_messages from anon, authenticated;
grant select on table public.polya_messages to authenticated;

create policy "polya_messages_select_own"
  on public.polya_messages for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Usage metering (service-role only)
-- ---------------------------------------------------------------------------
create table if not exists public.polya_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  tutor_count integer not null default 0,
  primary key (user_id, day)
);

alter table public.polya_usage enable row level security;
revoke all on table public.polya_usage from anon, authenticated;

create or replace function public.polya_increment_usage(
  p_user_id uuid,
  p_day date
)
returns integer
language sql
security definer
set search_path = public
as $$
  insert into public.polya_usage (user_id, day, tutor_count)
  values (p_user_id, p_day, 1)
  on conflict (user_id, day)
  do update set tutor_count = public.polya_usage.tutor_count + 1
  returning tutor_count;
$$;

revoke all on function public.polya_increment_usage(uuid, date) from public, anon, authenticated;
grant execute on function public.polya_increment_usage(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- Import work claim (service-role only): leases one actionable source for a
-- bounded processing step. Lease expires after 2 minutes so a crashed pump
-- never wedges the import; `for update skip locked` makes it double-tab safe.
-- ---------------------------------------------------------------------------
create or replace function public.polya_claim_import_work(
  p_user_id uuid,
  p_course_id uuid
)
returns setof public.polya_sources
language sql
security definer
set search_path = public
as $$
  update public.polya_sources
  set claimed_at = timezone('utc', now())
  where id = (
    select s.id
    from public.polya_sources s
    where s.user_id = p_user_id
      and s.course_id = p_course_id
      and s.status in ('queued', 'fetching', 'parsing', 'embedding')
      and (s.claimed_at is null or s.claimed_at < timezone('utc', now()) - interval '2 minutes')
    order by s.created_at
    limit 1
    for update skip locked
  )
  returning *;
$$;

revoke all on function public.polya_claim_import_work(uuid, uuid) from public, anon, authenticated;
grant execute on function public.polya_claim_import_work(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Retrieval RPCs (security invoker, RLS-scoped via auth.uid())
-- ---------------------------------------------------------------------------
create or replace function public.polya_match_units(
  p_course_id uuid,
  p_query_embedding extensions.vector(1536),
  p_limit integer default 12,
  p_exclude_roles text[] default '{}'::text[]
)
returns table (
  unit_id uuid,
  source_id uuid,
  unit_type text,
  content_role text,
  ordinal integer,
  heading_path text,
  page_start integer,
  page_end integer,
  t_start_ms integer,
  t_end_ms integer,
  procedure_id uuid,
  step_number integer,
  title text,
  content text,
  score real
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    u.id as unit_id,
    u.source_id,
    u.unit_type,
    u.content_role,
    u.ordinal,
    u.heading_path,
    u.page_start,
    u.page_end,
    u.t_start_ms,
    u.t_end_ms,
    u.procedure_id,
    u.step_number,
    s.title,
    u.content,
    (1 - (u.embedding <=> p_query_embedding))::real as score
  from public.polya_content_units u
  join public.polya_sources s on s.id = u.source_id
  where u.user_id = (select auth.uid())
    and u.course_id = p_course_id
    and u.embedding is not null
    and not (u.content_role = any(coalesce(p_exclude_roles, '{}'::text[])))
  order by u.embedding <=> p_query_embedding
  limit greatest(1, least(coalesce(p_limit, 12), 24));
$$;

grant execute on function public.polya_match_units(uuid, extensions.vector, integer, text[])
  to authenticated;

create or replace function public.polya_search_units_fts(
  p_course_id uuid,
  p_query text,
  p_limit integer default 12,
  p_exclude_roles text[] default '{}'::text[]
)
returns table (
  unit_id uuid,
  source_id uuid,
  unit_type text,
  content_role text,
  ordinal integer,
  heading_path text,
  page_start integer,
  page_end integer,
  t_start_ms integer,
  t_end_ms integer,
  procedure_id uuid,
  step_number integer,
  title text,
  content text,
  score real
)
language sql
stable
security invoker
set search_path = public
as $$
  with query as (
    select websearch_to_tsquery(
      'english',
      coalesce(nullif(trim(p_query), ''), 'course materials')
    ) as tsq
  )
  select
    u.id as unit_id,
    u.source_id,
    u.unit_type,
    u.content_role,
    u.ordinal,
    u.heading_path,
    u.page_start,
    u.page_end,
    u.t_start_ms,
    u.t_end_ms,
    u.procedure_id,
    u.step_number,
    s.title,
    u.content,
    ts_rank(u.search_vector, query.tsq)::real as score
  from public.polya_content_units u
  join public.polya_sources s on s.id = u.source_id
  cross join query
  where u.user_id = (select auth.uid())
    and u.course_id = p_course_id
    and not (u.content_role = any(coalesce(p_exclude_roles, '{}'::text[])))
    and u.search_vector @@ query.tsq
  order by score desc, u.ordinal asc
  limit greatest(1, least(coalesce(p_limit, 12), 24));
$$;

grant execute on function public.polya_search_units_fts(uuid, text, integer, text[])
  to authenticated;

-- ---------------------------------------------------------------------------
-- Storage bucket for originals + transcript uploads
-- Object path convention: {user_id}/{course_id}/{source_id}/original.{ext}
-- and {user_id}/uploads/{uuid}.{ext} for pre-registration transcript uploads.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('polya_documents', 'polya_documents', false)
on conflict (id) do nothing;

create policy "polya_documents_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'polya_documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "polya_documents_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'polya_documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
