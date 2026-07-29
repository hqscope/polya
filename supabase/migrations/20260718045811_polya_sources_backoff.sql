-- ============================================================================
-- Polya — quota-aware retry backoff for the import pump.
--
-- Problem: transient failures (Gemini free-tier quota, rate limits) were
-- retried on the 2-minute claim lease, so MAX_ATTEMPTS burned out in ~12
-- minutes against quotas that reset daily, stranding sources as `failed`.
--
-- Adds polya_sources.next_attempt_at — an explicit "not before" gate written by
-- the worker with a stretched backoff schedule — and teaches both claim RPCs to
-- skip gated rows. Also narrows the pg_cron sweeper to users who actually have
-- actionable work (or a course awaiting finalization), so a user whose sources
-- are all waiting out a long backoff isn't no-op-kicked every minute.
--
-- Additive-only; polya_ objects only; applied remotely via MCP apply_migration.
-- ============================================================================

alter table public.polya_sources
  add column if not exists next_attempt_at timestamptz;

-- ---------------------------------------------------------------------------
-- Single claim (legacy `process` action + tests): unchanged except the
-- next_attempt_at gate.
-- ---------------------------------------------------------------------------
create or replace function public.polya_claim_import_work(
  p_user_id uuid,
  p_course_id uuid
)
returns setof public.polya_sources
language sql
security definer
set search_path = public
as $$
  update public.polya_sources
  set claimed_at = timezone('utc', now())
  where id = (
    select s.id
    from public.polya_sources s
    where s.user_id = p_user_id
      and s.course_id = p_course_id
      and s.status in ('queued', 'fetching', 'parsing', 'embedding')
      and (s.claimed_at is null or s.claimed_at < timezone('utc', now()) - interval '2 minutes')
      and (s.next_attempt_at is null or s.next_attempt_at <= timezone('utc', now()))
    order by s.created_at
    limit 1
    for update skip locked
  )
  returning *;
$$;

revoke all on function public.polya_claim_import_work(uuid, uuid) from public, anon, authenticated;
grant execute on function public.polya_claim_import_work(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Batch claim (background pump): unchanged except the next_attempt_at gate.
-- ---------------------------------------------------------------------------
create or replace function public.polya_claim_import_batch(
  p_user_id uuid,
  p_course_id uuid,
  p_limit integer default 4
)
returns setof public.polya_sources
language sql
security definer
set search_path = public
as $$
  update public.polya_sources
  set claimed_at = timezone('utc', now())
  where id in (
    select s.id
    from public.polya_sources s
    where s.user_id = p_user_id
      and (p_course_id is null or s.course_id = p_course_id)
      and s.status in ('queued', 'fetching', 'parsing', 'embedding')
      and (s.claimed_at is null or s.claimed_at < timezone('utc', now()) - interval '2 minutes')
      and (s.next_attempt_at is null or s.next_attempt_at <= timezone('utc', now()))
    order by s.created_at
    limit greatest(1, least(coalesce(p_limit, 4), 10))
    for update skip locked
  )
  returning *;
$$;

revoke all on function public.polya_claim_import_batch(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.polya_claim_import_batch(uuid, uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Sweeper: only kick a user when a source is claimable *now*, or when some
-- importing course has no pending sources left (the pump must run once more to
-- flip it complete). Mechanics (vault secret, anon key, URL) are unchanged from
-- 20260718025436_polya_import_cron_sweeper.sql.
-- ---------------------------------------------------------------------------
create or replace function public.polya_sweep_stalled_imports()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  tok uuid;
  secret text;
  fn_url text := 'https://vcadcdgnwxjlgaoqktkd.supabase.co/functions/v1/polya-import';
  anon_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZjYWRjZGdud3hqbGdhb3FrdGtkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MzU4NDQsImV4cCI6MjA4NzIxMTg0NH0.71j6kwkwwSeG9Jppu4IUyHORM033NFyXKemOd5kuDWk';
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'polya_pump_secret';
  if secret is null then
    return; -- not configured (e.g. local dev) — nothing to do
  end if;

  for r in
    select distinct c.user_id
    from public.polya_courses c
    where c.import_status = 'importing'
      and (
        -- a source is claimable right now (lease expired AND backoff elapsed)
        exists (
          select 1
          from public.polya_sources s
          where s.user_id = c.user_id
            and s.status in ('queued', 'fetching', 'parsing', 'embedding')
            and (s.claimed_at is null or s.claimed_at < timezone('utc', now()) - interval '2 minutes')
            and (s.next_attempt_at is null or s.next_attempt_at <= timezone('utc', now()))
        )
        -- or an importing course finished all its sources and awaits finalization
        or exists (
          select 1
          from public.polya_courses c2
          where c2.user_id = c.user_id
            and c2.import_status = 'importing'
            and not exists (
              select 1
              from public.polya_sources s2
              where s2.course_id = c2.id
                and s2.status in ('queued', 'fetching', 'parsing', 'embedding')
            )
        )
      )
  loop
    tok := public.polya_acquire_import_lease(r.user_id, 150);
    if tok is not null then
      perform net.http_post(
        url := fn_url,
        body := jsonb_build_object('action', 'pump', 'user_id', r.user_id, 'lease_token', tok),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || anon_key,
          'x-polya-pump-secret', secret
        )
      );
    end if;
  end loop;
end;
$$;

revoke all on function public.polya_sweep_stalled_imports() from public, anon, authenticated;
