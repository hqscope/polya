-- ============================================================================
-- Polya on iMessage — submission-aware assignment reminders.
--
-- polya_imessage_reminders replaces polya_imessage_check_ins as the dedupe for
-- due_soon / due_today reminders. It is keyed by an item key instead of a
-- polya_sources id, so Gradescope assignments with no Canvas twin can be
-- reminded too:
--   canvas:<polya_sources.id>
--   gs:<gradescope course_id>:<gradescope assignment_id>
-- The sender inserts first and texts only if its insert won, so overlapping
-- or repeated runs are safe. Until this table exists, the agent keeps using
-- polya_imessage_check_ins (Canvas only).
--
-- polya_imessage_assignment_marks records what the student told the agent:
-- "done" (they turned it in) or "snoozed" until a time. Reminders skip a
-- marked item.
--
-- RLS on, zero policies, zero grants for anon/authenticated: service role only.
-- Additive-only; polya_ objects only. Not applied: per CLAUDE.md, rename with a
-- fresh UTC timestamp at apply time, run a local `supabase db reset`, then
-- apply via MCP apply_migration.
-- ============================================================================

create table if not exists public.polya_imessage_reminders (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_key text not null check (char_length(item_key) between 1 and 200),
  kind text not null check (kind in ('due_soon', 'due_today')),
  sent_at timestamptz not null default now(),
  unique (user_id, item_key, kind)
);

-- The daily cap reads a student's sends from the last day.
create index if not exists polya_imessage_reminders_user_sent_idx
  on public.polya_imessage_reminders (user_id, sent_at desc);

comment on table public.polya_imessage_reminders is
  'iMessage assignment reminders already sent, one per (student, item key, kind). Item key: canvas:<source id> or gs:<course>:<assignment>. Service role only.';

alter table public.polya_imessage_reminders enable row level security;
revoke all on table public.polya_imessage_reminders from anon, authenticated;

create table if not exists public.polya_imessage_assignment_marks (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_key text not null check (char_length(item_key) between 1 and 200),
  status text not null check (status in ('done', 'snoozed')),
  until timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, item_key)
);

comment on table public.polya_imessage_assignment_marks is
  'Assignments a linked student told the iMessage agent are done, or asked to snooze until a time. Service role only.';

alter table public.polya_imessage_assignment_marks enable row level security;
revoke all on table public.polya_imessage_assignment_marks from anon, authenticated;
