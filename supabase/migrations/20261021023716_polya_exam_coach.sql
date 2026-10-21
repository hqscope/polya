-- ============================================================================
-- Polya — Exam coach: a conversation inside each exam that teaches, puts
-- interactive practice questions in front of the student, keeps a study plan,
-- a mastery stage per topic and a mistake log, and runs timed mock exams.
--
--   polya_mock_exams     read own; written by polya-study (service role)
--   polya_study_errors   read own, delete own (clear a mistake); written by polya-coach
--   polya_conversations  + exam_id (a coach thread belongs to one exam)
--   polya_messages       + blocks (the coach's interactive pieces, in order), meta
--   polya_study_topics   + stage / stage_note / stage_updated_at
--   polya_practice_questions + origin, topic_ids, hide_topic, difficulty, conversation_id
--   polya_practice_attempts  + topic_ids, mock_id
--   polya_exams          + plan / plan_updated_at
--
-- Message rows stay student-readable, so blocks never carry answer keys; keys
-- stay in polya_practice_keys (readable only after an attempt). A mock exam
-- only reuses questions the student has never attempted, so starting one
-- never makes a key readable early.
--
-- Additive-only; polya_ objects only. The existing conversation policies only
-- check user_id, so the new exam_id gets restrictive policies (ANDed with the
-- permissive ones) instead of rewriting them.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Mock exams
-- ---------------------------------------------------------------------------
create table if not exists public.polya_mock_exams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null references public.polya_courses (id) on delete cascade,
  exam_id uuid not null references public.polya_exams (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  minutes integer not null check (minutes between 10 and 180),
  -- { question_count, topic_weights: { topic_id: 1..5 }, free_response }
  spec jsonb not null check (jsonb_typeof(spec) = 'object'),
  question_ids uuid[] not null default '{}' check (cardinality(question_ids) <= 12),
  status text not null default 'building'
    check (status in ('building', 'ready', 'in_progress', 'submitted')),
  started_at timestamptz,
  due_at timestamptz,
  submitted_at timestamptz,
  score real check (score is null or (score >= 0 and score <= 1)),
  report jsonb check (report is null or jsonb_typeof(report) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

comment on table public.polya_mock_exams is
  'A timed mock exam for one exam: its questions, the clock, and the report once handed in.';

create index if not exists polya_mock_exams_exam_idx
  on public.polya_mock_exams (user_id, exam_id, created_at desc);
create index if not exists polya_mock_exams_open_idx
  on public.polya_mock_exams (user_id)
  where status in ('ready', 'in_progress');

alter table public.polya_mock_exams enable row level security;
revoke all on table public.polya_mock_exams from anon, authenticated;
grant select on table public.polya_mock_exams to authenticated;

create policy "polya_mock_exams_select_own" on public.polya_mock_exams
  for select to authenticated
  using ((select auth.uid()) = user_id);

create trigger polya_mock_exams_touch
  before update on public.polya_mock_exams
  for each row execute function public.polya_set_updated_at();

-- ---------------------------------------------------------------------------
-- Mistake log
-- ---------------------------------------------------------------------------
create table if not exists public.polya_study_errors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  exam_id uuid not null references public.polya_exams (id) on delete cascade,
  topic_id uuid references public.polya_study_topics (id) on delete cascade,
  question_id uuid references public.polya_practice_questions (id) on delete set null,
  attempt_id uuid references public.polya_practice_attempts (id) on delete set null,
  what text not null check (char_length(btrim(what)) between 1 and 300),
  why text not null default '' check (char_length(why) <= 600),
  fix text not null default '' check (char_length(fix) <= 600),
  created_at timestamptz not null default timezone('utc', now())
);

comment on table public.polya_study_errors is
  'Mistakes worth fixing before an exam: what went wrong, why, and how to avoid it. Fixed = a later fully right answer on the topic.';

create index if not exists polya_study_errors_exam_idx
  on public.polya_study_errors (user_id, exam_id, created_at desc);

alter table public.polya_study_errors enable row level security;
revoke all on table public.polya_study_errors from anon, authenticated;
grant select, delete on table public.polya_study_errors to authenticated;

create policy "polya_study_errors_select_own" on public.polya_study_errors
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "polya_study_errors_delete_own" on public.polya_study_errors
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Coach threads: a conversation can belong to one exam
-- ---------------------------------------------------------------------------
alter table public.polya_conversations
  add column if not exists exam_id uuid references public.polya_exams (id) on delete cascade;

create index if not exists polya_conversations_exam_idx
  on public.polya_conversations (user_id, exam_id, last_message_at desc)
  where exam_id is not null;

-- Restrictive: ANDed with the existing permissive insert/update policies.
create policy "polya_conversations_exam_owned_insert" on public.polya_conversations
  as restrictive for insert to authenticated
  with check (
    exam_id is null
    or exists (
      select 1 from public.polya_exams e
      where e.id = exam_id and e.user_id = (select auth.uid()) and e.course_id = polya_conversations.course_id
    )
  );

create policy "polya_conversations_exam_owned_update" on public.polya_conversations
  as restrictive for update to authenticated
  using (true)
  with check (
    exam_id is null
    or exists (
      select 1 from public.polya_exams e
      where e.id = exam_id and e.user_id = (select auth.uid()) and e.course_id = polya_conversations.course_id
    )
  );

-- The coach's interactive pieces, in order with its text:
-- [{ type: "text", text } | { type: "block", block }]. Never answer keys.
alter table public.polya_messages
  add column if not exists blocks jsonb check (blocks is null or jsonb_typeof(blocks) = 'array'),
  add column if not exists meta jsonb check (meta is null or jsonb_typeof(meta) = 'object');

-- ---------------------------------------------------------------------------
-- Mastery stage per topic (not_started / needs_review are derived on read)
-- ---------------------------------------------------------------------------
alter table public.polya_study_topics
  add column if not exists stage text check (stage is null or stage in ('learning', 'practicing', 'exam_ready')),
  add column if not exists stage_note text check (stage_note is null or char_length(stage_note) <= 500),
  add column if not exists stage_updated_at timestamptz;

-- ---------------------------------------------------------------------------
-- Questions the coach writes mid-conversation, and mixed-topic questions
-- ---------------------------------------------------------------------------
alter table public.polya_practice_questions
  -- bank: independently re-solved before use (Practice, mock exams).
  -- coach: checked by fixed rules only; shown in its conversation, nowhere else.
  add column if not exists origin text not null default 'bank' check (origin in ('bank', 'coach')),
  add column if not exists topic_ids uuid[] not null default '{}' check (cardinality(topic_ids) <= 4),
  add column if not exists hide_topic boolean not null default false,
  add column if not exists difficulty smallint check (difficulty is null or difficulty between 1 and 3),
  add column if not exists conversation_id uuid references public.polya_conversations (id) on delete set null;

alter table public.polya_practice_attempts
  add column if not exists topic_ids uuid[] not null default '{}' check (cardinality(topic_ids) <= 4),
  add column if not exists mock_id uuid references public.polya_mock_exams (id) on delete set null;

create index if not exists polya_practice_attempts_mock_idx
  on public.polya_practice_attempts (mock_id)
  where mock_id is not null;

-- ---------------------------------------------------------------------------
-- Study plan: { days: [{ date, focus, items: [{ id, topic_id, text, done }] }], note }
-- ---------------------------------------------------------------------------
alter table public.polya_exams
  add column if not exists plan jsonb
    check (plan is null or (jsonb_typeof(plan) = 'object' and octet_length(plan::text) <= 20000)),
  add column if not exists plan_updated_at timestamptz;
