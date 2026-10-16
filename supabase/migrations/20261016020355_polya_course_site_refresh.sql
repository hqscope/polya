-- ============================================================================
-- Polya — keep course websites current without a student clicking anything.
-- Every 30 minutes, claim up to 4 course websites not checked in 20 hours and
-- ask polya-import to re-check each one (action `site_refresh`): anything new
-- on the site is queued, and the site's own pages are re-read (hash-compared,
-- so unchanged pages keep their passages). Big files are left to a manual
-- "Check for updates". Same transport as the import sweeper: pg_net, the
-- low-privilege pump secret from Vault, the public anon key for the JWT
-- gateway; no user data and no service-role key in the DB.
--
-- polya_courses.site_checked_at is stamped by every check (scheduled or not),
-- and by the claim below so overlapping runs never pick the same course.
--
-- Additive; polya_ objects only; applied remotely via MCP apply_migration.
-- Locally a no-op (no pump secret in the local Vault), so a dev stack never
-- pings prod.
-- ============================================================================

alter table public.polya_courses
  add column if not exists site_checked_at timestamptz;

comment on column public.polya_courses.site_checked_at is
  'When the course website was last checked for new or changed material.';

create or replace function public.polya_refresh_course_sites()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  secret text;
  fn_url text := 'https://vcadcdgnwxjlgaoqktkd.supabase.co/functions/v1/polya-import';
  anon_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZjYWRjZGdud3hqbGdhb3FrdGtkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MzU4NDQsImV4cCI6MjA4NzIxMTg0NH0.71j6kwkwwSeG9Jppu4IUyHORM033NFyXKemOd5kuDWk';
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'polya_pump_secret';
  if secret is null then
    return; -- not configured (e.g. local dev) — nothing to do
  end if;

  for r in
    update public.polya_courses c
    set site_checked_at = timezone('utc', now())
    where c.id in (
      select id
      from public.polya_courses
      where site_url is not null
        and import_status <> 'importing'
        and (site_checked_at is null or site_checked_at < timezone('utc', now()) - interval '20 hours')
      order by site_checked_at nulls first
      limit 4
      for update skip locked
    )
    returning c.id
  loop
    perform net.http_post(
      url := fn_url,
      body := jsonb_build_object('action', 'site_refresh', 'course_id', r.id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || anon_key,
        'x-polya-pump-secret', secret
      )
    );
  end loop;
end;
$$;

revoke all on function public.polya_refresh_course_sites() from public, anon, authenticated;

-- Every 30 minutes. cron.schedule upserts by job name, so re-applying is safe.
select cron.schedule('polya-site-refresh', '*/30 * * * *', $$select public.polya_refresh_course_sites()$$);
