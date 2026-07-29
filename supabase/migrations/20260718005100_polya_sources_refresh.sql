-- Source freshness: re-import detects changed Canvas content and re-queues it.
-- `needs_refresh` marks a source whose Canvas copy looks newer (or force-checked);
-- the pump re-fetches, hash-compares content_sha256, and rebuilds units only on
-- real change. `due_at` persists assignment due dates (previously discarded).
alter table public.polya_sources
  add column if not exists due_at timestamptz,
  add column if not exists needs_refresh boolean not null default false;
