-- ============================================================================
-- Polya on iMessage — three more reminder kinds.
--
-- polya_imessage_reminders.kind accepted due_soon and due_today. The check-in
-- loop now also sends:
--   last_call       due within 6 hours and not submitted
--   graded          a Gradescope assignment came back graded with a score
--   new_assignment  an assignment was just posted, due more than 48 hours out
-- Until this is applied, inserts of the new kinds fail this check (23514) and
-- the agent skips those kinds, so it keeps sending due_soon and due_today
-- exactly as before.
--
-- Baseline rows: on a student's first run with Gradescope, the loop records
-- every Gradescope assignment they already have (new_assignment, plus graded
-- when it's already graded) with sent_at = 1970-01-01 00:00:00+00. Those rows
-- were never texted; they stop old work from being announced as new.
--
-- The constraint name is Postgres's default for the inline column check in
-- 20261016002618_polya_imessage_reminders.sql (confirmed on the remote:
-- polya_imessage_reminders_kind_check).
--
-- polya_ objects only; additive (the check only widens). Not applied: per
-- CLAUDE.md, rename with a fresh UTC timestamp at apply time, run a local
-- `supabase db reset`, then apply via MCP apply_migration.
-- ============================================================================

alter table public.polya_imessage_reminders
  drop constraint if exists polya_imessage_reminders_kind_check;

alter table public.polya_imessage_reminders
  add constraint polya_imessage_reminders_kind_check
  check (kind in ('due_soon', 'due_today', 'last_call', 'graded', 'new_assignment'));

comment on column public.polya_imessage_reminders.sent_at is
  'When the reminder was sent. 1970-01-01 00:00:00+00 marks a baseline row: a Gradescope assignment the student already had on their first run, recorded as seen and never texted.';
