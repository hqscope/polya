-- Retry bookkeeping for the import pump. `attempts` lets processOneStep tell a
-- transient failure (Gemini quota / rate limit / 5xx / network) — which should
-- be retried via the claim lease — from a permanent one, and cap the retries so
-- a wedged source eventually fails instead of looping forever. `last_error_at`
-- records when the most recent failure happened. Additive-only.
alter table public.polya_sources
  add column if not exists attempts integer not null default 0;

alter table public.polya_sources
  add column if not exists last_error_at timestamptz;
