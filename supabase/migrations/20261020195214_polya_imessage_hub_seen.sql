-- ============================================================================
-- Polya on iMessage — personal digest dedupe (hub owner only).
--
-- The iMessage agent's check-in loop also reads its owner's personal hub
-- (unread mail, bCourses announcements, calendar) and hands new items to the
-- owner's own thread. One row per (user, item key) records what was already
-- handed off; the loop claims a key here before it sends and deletes the claim
-- if the send fails. Only keys and times are stored, never content:
--   gmail:<message id>
--   canvas:<announcement id>
--   cal:<event id>:<start>
--   brief:<YYYY-MM-DD>          one morning brief per local day
--   digest:sent:<ISO time>      one per digest text; the daily cap counts these
-- The agent sends no digest until this migration is applied.
--
-- RLS on, zero policies, zero grants for anon/authenticated: service role only.
-- Additive-only; polya_ objects only. Not applied: per CLAUDE.md, rename with a
-- fresh UTC timestamp at apply time, run a local `supabase db reset`, then
-- apply via MCP apply_migration.
-- ============================================================================

create table if not exists public.polya_imessage_hub_seen (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_key text not null check (char_length(item_key) between 1 and 300),
  seen_at timestamptz not null default now(),
  primary key (user_id, item_key)
);

comment on table public.polya_imessage_hub_seen is
  'Personal-digest items the iMessage agent already handed to the hub owner''s thread, plus brief:<date> and digest:sent:<time> rows. Keys and times only. Service role only.';

alter table public.polya_imessage_hub_seen enable row level security;
revoke all on table public.polya_imessage_hub_seen from anon, authenticated;
