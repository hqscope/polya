-- ============================================================================
-- Polya on iMessage — exam reminders.
--
-- The check-in loop now also texts students about exams they added in Study
-- (polya_exams with an exam_date), one text per milestone:
--   exam_week   4 to 7 days out: offer a plan
--   exam_soon   2 to 3 days out: weakest topics, offer a quiz by text
--   exam_eve    the day before, from 5 PM local: review topics and a
--               last-minute list (key formulas, open mistakes)
--   exam_day    the morning of: a short note with what to remember
-- Each send is claimed in polya_imessage_reminders under the item key
-- exam:<exam id>:<exam date>, so a rescheduled exam starts fresh. Until this
-- is applied, inserts of the new kinds fail this check (23514) and the loop
-- skips exam texts; assignment check-ins are unaffected.
--
-- The constraint name is Postgres's default for the inline column check in
-- 20261016002618_polya_imessage_reminders.sql, widened by
-- 20261016024128_polya_imessage_reminder_kinds.sql (confirmed on the remote:
-- polya_imessage_reminders_kind_check).
--
-- polya_ objects only; additive (the check only widens).
-- ============================================================================

alter table public.polya_imessage_reminders
  drop constraint if exists polya_imessage_reminders_kind_check;

alter table public.polya_imessage_reminders
  add constraint polya_imessage_reminders_kind_check
  check (kind in (
    'due_soon', 'due_today', 'last_call', 'graded', 'new_assignment',
    'exam_week', 'exam_soon', 'exam_eve', 'exam_day'
  ));

comment on table public.polya_imessage_reminders is
  'iMessage reminders already sent, one per (student, item key, kind). Item key: canvas:<source id>, gs:<course>:<assignment>, or exam:<exam id>:<exam date>. Service role only.';
