-- Fix: the import upsert uses ON CONFLICT (user_id, course_id, origin, canvas_id)
-- DO NOTHING, but the arbiter was a PARTIAL unique index (`where canvas_id is
-- not null`). Postgres cannot use a partial index as an ON CONFLICT arbiter
-- unless the statement repeats the predicate (PostgREST can't), so the upsert
-- errored (42P10). Replace it with a full unique index — NULL canvas_id rows
-- (uploaded transcripts) are still allowed because NULLs compare distinct.
drop index if exists public.polya_sources_canvas_identity_idx;

create unique index if not exists polya_sources_canvas_identity_idx
  on public.polya_sources (user_id, course_id, origin, canvas_id);
