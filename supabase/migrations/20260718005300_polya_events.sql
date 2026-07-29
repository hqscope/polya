-- Product analytics: one row per event, queryable with plain SQL.
-- Clients insert their own events (insert-only RLS — abuse caps out at
-- self-attributed noise); edge functions insert server-side events via the
-- service role. No select grant: metrics are read via service-role SQL.
-- course_id has no FK on purpose — events outlive course deletion.
create table if not exists public.polya_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  event text not null check (char_length(event) between 1 and 64),
  course_id uuid,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists polya_events_event_time_idx
  on public.polya_events (event, created_at);
create index if not exists polya_events_user_time_idx
  on public.polya_events (user_id, created_at);

alter table public.polya_events enable row level security;
revoke all on table public.polya_events from anon, authenticated;
grant insert on table public.polya_events to authenticated;

create policy "polya_events_insert_own" on public.polya_events
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
