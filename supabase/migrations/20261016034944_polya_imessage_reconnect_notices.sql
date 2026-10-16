-- ============================================================================
-- Polya on iMessage — reconnect notices.
--
-- When a student's Gradescope sign-in or Canvas connection stops working, the
-- iMessage agent's check-in loop texts them a link to fix it, at most once a
-- day while it stays broken. One row per student and service records when
-- that text last went out; the agent deletes the row once the service works
-- again (or the student reconnects from the web page). The agent texts nothing
-- until this migration is applied.
--
-- RLS on, zero policies, zero grants for anon/authenticated: service role only.
-- Additive-only; polya_ objects only. Not applied: per CLAUDE.md, rename with a
-- fresh UTC timestamp at apply time, run a local `supabase db reset`, then
-- apply via MCP apply_migration.
-- ============================================================================

create table if not exists public.polya_imessage_reconnect_notices (
  user_id uuid not null references auth.users(id) on delete cascade,
  service text not null check (service in ('canvas', 'gradescope')),
  texted_at timestamptz not null default now(),
  primary key (user_id, service)
);

comment on table public.polya_imessage_reconnect_notices is
  'When the iMessage agent last texted a student a reconnect link for a broken Canvas or Gradescope connection. Service role only.';

alter table public.polya_imessage_reconnect_notices enable row level security;
revoke all on table public.polya_imessage_reconnect_notices from anon, authenticated;
