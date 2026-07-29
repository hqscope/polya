-- Mastery checks: after guided help, the tutor poses one transfer question the
-- student solves without help; the tutor judges the attempt and the outcome is
-- persisted. This is the learning-evidence layer ("can you do a related one on
-- your own now?"), not another chat log.
create table if not exists public.polya_mastery_checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null references public.polya_courses (id) on delete cascade,
  conversation_id uuid references public.polya_conversations (id) on delete set null,
  concept text not null,
  question text not null default '',
  status text not null default 'asked' check (status in ('asked', 'completed')),
  verdict text check (verdict in ('pass', 'partial', 'fail')),
  feedback text,
  -- Reserved: highest help-ladder level used before the check. Null until the
  -- tutor emits a machine-readable level marker.
  help_level_used_before integer,
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz
);

create index if not exists polya_mastery_checks_user_course_idx
  on public.polya_mastery_checks (user_id, course_id, created_at desc);

alter table public.polya_mastery_checks enable row level security;
revoke all on table public.polya_mastery_checks from anon, authenticated;
grant select on table public.polya_mastery_checks to authenticated;

-- Writes go through the service role only (polya-tutor), same as polya_messages.
create policy "polya_mastery_checks_select_own" on public.polya_mastery_checks
  for select to authenticated
  using ((select auth.uid()) = user_id);
