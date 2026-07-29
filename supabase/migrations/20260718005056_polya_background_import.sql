-- ============================================================================
-- Polya — background, multi-course import support. Additive-only; every object
-- is polya_-prefixed and applied via MCP apply_migration only (CLAUDE.md rules).
--
-- Adds:
--  * polya_import_jobs — a per-user single-flight lease for the background
--    import worker: it bounds concurrency and drives the UI "importing"
--    indicator. It is NOT what makes processing safe — that is still the
--    per-row `for update skip locked` claim lease on polya_sources.
--  * polya_acquire/renew/release_import_lease — token-based lease so a worker
--    that hands off to a fresh self-invocation continues the same job, while a
--    stale duplicate worker is rejected and exits.
--  * polya_claim_import_batch — leases up to N actionable sources at once and,
--    when p_course_id is null, across ALL of a user's courses, so one worker
--    drains an "import all" with intra-invocation concurrency.
--
-- `start` still enumerates synchronously (fast; preserves the diffSources
-- refresh/force contract). Only the slow *processing* — fetch/OCR/embed — moves
-- to the background worker; the client no longer drives the pump loop.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Per-user background import worker lease (single-flight).
-- RLS: owner may read their own row (so the client indicator can tell a worker
-- is alive); only service-role edge functions write it.
-- ---------------------------------------------------------------------------
create table if not exists public.polya_import_jobs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'idle' check (status in ('running', 'idle')),
  lease_token uuid,
  leased_until timestamptz,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.polya_import_jobs enable row level security;
revoke all on table public.polya_import_jobs from anon, authenticated;
grant select on table public.polya_import_jobs to authenticated;

create policy "polya_import_jobs_select_own"
  on public.polya_import_jobs for select
  to authenticated
  using ((select auth.uid()) = user_id);

create trigger polya_import_jobs_touch
  before update on public.polya_import_jobs
  for each row execute function public.polya_set_updated_at();

-- ---------------------------------------------------------------------------
-- Lease RPCs (service-role only). Token-based so a hand-off (self-fetch to a
-- fresh worker invocation) continues the same logical job.
-- ---------------------------------------------------------------------------

-- Acquire iff no live lease. Mints + returns a fresh token, or null when a
-- worker already holds an unexpired lease (the unique PK + ON CONFLICT
-- serializes racing callers, so exactly one wins).
create or replace function public.polya_acquire_import_lease(
  p_user_id uuid,
  p_ttl_seconds integer default 150
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token uuid;
begin
  insert into public.polya_import_jobs (user_id, status, lease_token, leased_until)
  values (
    p_user_id, 'running', gen_random_uuid(),
    timezone('utc', now()) + make_interval(secs => p_ttl_seconds)
  )
  on conflict (user_id) do update
    set status = 'running',
        lease_token = gen_random_uuid(),
        leased_until = timezone('utc', now()) + make_interval(secs => p_ttl_seconds)
    where public.polya_import_jobs.leased_until is null
       or public.polya_import_jobs.leased_until < timezone('utc', now())
  returning lease_token into v_token;

  return v_token; -- null when the conflict-update was filtered out (live lease)
end;
$$;

revoke all on function public.polya_acquire_import_lease(uuid, integer) from public, anon, authenticated;
grant execute on function public.polya_acquire_import_lease(uuid, integer) to service_role;

-- Extend the lease iff the caller still holds the matching token.
create or replace function public.polya_renew_import_lease(
  p_user_id uuid,
  p_token uuid,
  p_ttl_seconds integer default 150
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  update public.polya_import_jobs
    set leased_until = timezone('utc', now()) + make_interval(secs => p_ttl_seconds)
    where user_id = p_user_id
      and lease_token = p_token
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

revoke all on function public.polya_renew_import_lease(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.polya_renew_import_lease(uuid, uuid, integer) to service_role;

-- Release the lease (worker finished / no work left). Idempotent.
create or replace function public.polya_release_import_lease(
  p_user_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.polya_import_jobs
    set status = 'idle', lease_token = null, leased_until = null
    where user_id = p_user_id;
$$;

revoke all on function public.polya_release_import_lease(uuid) from public, anon, authenticated;
grant execute on function public.polya_release_import_lease(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Batch claim: lease up to p_limit actionable sources at once. When
-- p_course_id is null, claim across ALL of the user's courses. Same 2-minute
-- lease + `for update skip locked` as polya_claim_import_work, so concurrent
-- workers never double-process a source.
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
    order by s.created_at
    limit greatest(1, least(coalesce(p_limit, 4), 10))
    for update skip locked
  )
  returning *;
$$;

revoke all on function public.polya_claim_import_batch(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.polya_claim_import_batch(uuid, uuid, integer) to service_role;
