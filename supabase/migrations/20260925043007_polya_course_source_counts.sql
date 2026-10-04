-- Per-course source counts for the /app course list (platform-hardening
-- POLISH P-27). The page used to download every polya_sources row for every
-- course just to count them; this returns one row per course instead.
--
-- security_invoker: the caller's own RLS on polya_sources applies
-- ("polya_sources_select_own"), so each student only ever counts their own
-- sources. Additive only: no existing object changes.
--
-- in_progress = the non-terminal statuses, the same set the import pump
-- claims ('queued', 'fetching', 'parsing', 'embedding').

create view public.polya_course_source_counts
with (security_invoker = true)
as
select
  s.course_id,
  count(*)::int as total,
  (count(*) filter (where s.status = 'ready'))::int as ready,
  (count(*) filter (where s.status in ('queued', 'fetching', 'parsing', 'embedding')))::int
    as in_progress
from public.polya_sources s
group by s.course_id;

comment on view public.polya_course_source_counts is
  'Per-course source totals for the Polya course list. security_invoker, so polya_sources RLS scopes it to the caller.';

revoke all on table public.polya_course_source_counts from anon, authenticated;
grant select on table public.polya_course_source_counts to authenticated;
