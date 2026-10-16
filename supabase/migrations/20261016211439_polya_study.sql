-- ============================================================================
-- Polya — Study: exam prep inside a course.
--
-- A student adds an exam (title, date, the instructor's scope announcement,
-- example questions), marks which of the course's files are the formula sheet
-- and past exams, and gets a topic map they can edit. Practice questions are
-- written per topic from the course materials; the answer key is checked by
-- fixed rules (polya-study, _shared/study-expr.ts), never by a model, and
-- every attempt is recorded so weak topics can be found.
--
--   polya_exams              student-owned (CRUD own; course must be theirs)
--   polya_exam_sources       student-owned (CRUD own; exam and file must be theirs, same course)
--   polya_study_topics       student-owned (CRUD own; exam must be theirs)
--   polya_practice_questions read own; written by polya-study (service role)
--   polya_practice_keys      read own ONLY after an attempt exists; written by polya-study
--   polya_practice_attempts  read own; written by polya-study
--
-- The question row never carries answers. The key becomes readable once the
-- student has attempted the question — exactly what grading already returned.
--
-- Additive-only; polya_ objects only. Passed a local `supabase db reset` and an
-- RLS check (cross-user access, keys before an attempt, client writes to
-- questions/attempts, anon); applied 2026-10-16 via MCP apply_migration.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Exams
-- ---------------------------------------------------------------------------
create table if not exists public.polya_exams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null references public.polya_courses (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  exam_date date,
  scope_note text check (scope_note is null or char_length(scope_note) <= 20000),
  examples_note text check (examples_note is null or char_length(examples_note) <= 40000),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

comment on table public.polya_exams is
  'An exam a student is preparing for in one course: title, date, pasted scope and example questions.';

create index if not exists polya_exams_user_course_idx
  on public.polya_exams (user_id, course_id, created_at desc);

alter table public.polya_exams enable row level security;
revoke all on table public.polya_exams from anon, authenticated;
grant select, insert, update, delete on table public.polya_exams to authenticated;

create policy "polya_exams_select_own" on public.polya_exams
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "polya_exams_insert_own" on public.polya_exams
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.polya_courses c
      where c.id = course_id and c.user_id = (select auth.uid())
    )
  );

create policy "polya_exams_update_own" on public.polya_exams
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.polya_courses c
      where c.id = course_id and c.user_id = (select auth.uid())
    )
  );

create policy "polya_exams_delete_own" on public.polya_exams
  for delete to authenticated
  using ((select auth.uid()) = user_id);

create trigger polya_exams_touch
  before update on public.polya_exams
  for each row execute function public.polya_set_updated_at();

-- ---------------------------------------------------------------------------
-- Which of the course's files are the formula sheet / past exams for an exam
-- ---------------------------------------------------------------------------
create table if not exists public.polya_exam_sources (
  exam_id uuid not null references public.polya_exams (id) on delete cascade,
  source_id uuid not null references public.polya_sources (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('formula_sheet', 'past_exam')),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (exam_id, source_id)
);

comment on table public.polya_exam_sources is
  'Files the student marked as the formula sheet or a past exam for one exam.';

create index if not exists polya_exam_sources_source_idx
  on public.polya_exam_sources (source_id);

alter table public.polya_exam_sources enable row level security;
revoke all on table public.polya_exam_sources from anon, authenticated;
grant select, insert, update, delete on table public.polya_exam_sources to authenticated;

create policy "polya_exam_sources_select_own" on public.polya_exam_sources
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- The exam and the file are both the student's, and the file is in the
-- exam's course.
create policy "polya_exam_sources_insert_own" on public.polya_exam_sources
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.polya_exams e
      join public.polya_sources s on s.course_id = e.course_id
      where e.id = exam_id and s.id = source_id
        and e.user_id = (select auth.uid()) and s.user_id = (select auth.uid())
    )
  );

create policy "polya_exam_sources_update_own" on public.polya_exam_sources
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.polya_exams e
      join public.polya_sources s on s.course_id = e.course_id
      where e.id = exam_id and s.id = source_id
        and e.user_id = (select auth.uid()) and s.user_id = (select auth.uid())
    )
  );

create policy "polya_exam_sources_delete_own" on public.polya_exam_sources
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Topic map
-- ---------------------------------------------------------------------------
create table if not exists public.polya_study_topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  exam_id uuid not null references public.polya_exams (id) on delete cascade,
  position integer not null default 0 check (position between 0 and 999),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  summary text check (summary is null or char_length(summary) <= 600),
  -- LaTeX, shown typeset. Capped as a whole rather than per element.
  key_formulas text[] not null default '{}'
    check (cardinality(key_formulas) <= 12 and char_length(array_to_string(key_formulas, '')) <= 4000),
  -- Course files this topic draws on (polya_sources ids). Advisory only: the
  -- server re-checks ownership before reading any of them.
  source_ids uuid[] not null default '{}' check (cardinality(source_ids) <= 20),
  origin text not null default 'student' check (origin in ('proposed', 'student')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

comment on table public.polya_study_topics is
  'Topics on one exam, suggested by Polya or added by the student, in study order.';

create index if not exists polya_study_topics_exam_idx
  on public.polya_study_topics (exam_id, position);

alter table public.polya_study_topics enable row level security;
revoke all on table public.polya_study_topics from anon, authenticated;
grant select, insert, update, delete on table public.polya_study_topics to authenticated;

create policy "polya_study_topics_select_own" on public.polya_study_topics
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "polya_study_topics_insert_own" on public.polya_study_topics
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.polya_exams e
      where e.id = exam_id and e.user_id = (select auth.uid())
    )
  );

create policy "polya_study_topics_update_own" on public.polya_study_topics
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.polya_exams e
      where e.id = exam_id and e.user_id = (select auth.uid())
    )
  );

create policy "polya_study_topics_delete_own" on public.polya_study_topics
  for delete to authenticated
  using ((select auth.uid()) = user_id);

create trigger polya_study_topics_touch
  before update on public.polya_study_topics
  for each row execute function public.polya_set_updated_at();

-- ---------------------------------------------------------------------------
-- Practice questions (public half: no answers)
-- ---------------------------------------------------------------------------
create table if not exists public.polya_practice_questions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null references public.polya_courses (id) on delete cascade,
  exam_id uuid not null references public.polya_exams (id) on delete cascade,
  topic_id uuid not null references public.polya_study_topics (id) on delete cascade,
  stem text not null check (char_length(stem) <= 4000),
  -- [{ kind: "numeric" | "mc" | "select_all", prompt, options? }] — never answers.
  parts jsonb not null check (jsonb_typeof(parts) = 'array'),
  sources jsonb not null default '[]'::jsonb,
  model text,
  status text not null default 'active' check (status in ('active', 'flagged')),
  created_at timestamptz not null default timezone('utc', now())
);

comment on table public.polya_practice_questions is
  'Practice questions written from the course materials for one exam topic. Answers live in polya_practice_keys.';

create index if not exists polya_practice_questions_exam_topic_idx
  on public.polya_practice_questions (exam_id, topic_id, created_at desc);

alter table public.polya_practice_questions enable row level security;
revoke all on table public.polya_practice_questions from anon, authenticated;
grant select on table public.polya_practice_questions to authenticated;

create policy "polya_practice_questions_select_own" on public.polya_practice_questions
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Practice attempts (graded by polya-study)
-- ---------------------------------------------------------------------------
create table if not exists public.polya_practice_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  question_id uuid not null references public.polya_practice_questions (id) on delete cascade,
  exam_id uuid not null references public.polya_exams (id) on delete cascade,
  topic_id uuid not null references public.polya_study_topics (id) on delete cascade,
  responses jsonb not null,
  results jsonb not null,
  score real not null check (score >= 0 and score <= 1),
  all_correct boolean not null,
  created_at timestamptz not null default timezone('utc', now())
);

comment on table public.polya_practice_attempts is
  'Each graded attempt at a practice question: what the student answered and which parts were right.';

create index if not exists polya_practice_attempts_exam_idx
  on public.polya_practice_attempts (user_id, exam_id, created_at desc);
create index if not exists polya_practice_attempts_question_idx
  on public.polya_practice_attempts (question_id, created_at desc);

alter table public.polya_practice_attempts enable row level security;
revoke all on table public.polya_practice_attempts from anon, authenticated;
grant select on table public.polya_practice_attempts to authenticated;

create policy "polya_practice_attempts_select_own" on public.polya_practice_attempts
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Answer keys (private until attempted)
-- ---------------------------------------------------------------------------
create table if not exists public.polya_practice_keys (
  question_id uuid primary key references public.polya_practice_questions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- [{ kind: "numeric", expr, value } | { kind: "mc", correct } | { kind: "select_all", correct }]
  answers jsonb not null check (jsonb_typeof(answers) = 'array'),
  explanation text not null check (char_length(explanation) <= 8000),
  -- How the key was checked (independent re-solve agreement, drop reasons).
  verification jsonb not null default '{}'::jsonb,
  flag_note text check (flag_note is null or char_length(flag_note) <= 1000),
  flagged_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

comment on table public.polya_practice_keys is
  'Answer key and worked explanation for a practice question. Readable by its student only after an attempt.';

alter table public.polya_practice_keys enable row level security;
revoke all on table public.polya_practice_keys from anon, authenticated;
grant select on table public.polya_practice_keys to authenticated;

create policy "polya_practice_keys_select_after_attempt" on public.polya_practice_keys
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.polya_practice_attempts a
      where a.question_id = polya_practice_keys.question_id
        and a.user_id = (select auth.uid())
    )
  );
