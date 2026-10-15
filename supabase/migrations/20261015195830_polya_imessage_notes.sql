-- ============================================================================
-- Polya on iMessage — long-range notes about a student.
--
-- Short facts the iMessage agent saves in one conversation and recalls in
-- later ones and in check-ins: a goal, how the student likes help, a plan they
-- said they'd follow, or something they found hard. The agent (service role)
-- reads and writes them only for the linked student's user_id, taken from the
-- session it runs in, never from the model. The agent runs without memory
-- until this migration is applied.
--
-- RLS on, zero policies, zero grants for anon/authenticated: service role only.
-- Additive-only; polya_ objects only. Not applied: per CLAUDE.md, rename with a
-- fresh UTC timestamp at apply time, run a local `supabase db reset`, then
-- apply via MCP apply_migration.
-- ============================================================================

create table if not exists public.polya_imessage_notes (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('goal', 'preference', 'plan', 'struggle', 'other')),
  note text not null check (char_length(note) between 1 and 280),
  created_at timestamptz not null default now()
);

create index if not exists polya_imessage_notes_user_recent_idx
  on public.polya_imessage_notes (user_id, created_at desc);

comment on table public.polya_imessage_notes is
  'Long-range notes the iMessage agent keeps about a linked student (goals, preferences, plans, struggles). Service role only.';

alter table public.polya_imessage_notes enable row level security;
revoke all on table public.polya_imessage_notes from anon, authenticated;
