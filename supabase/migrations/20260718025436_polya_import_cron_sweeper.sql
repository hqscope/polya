-- ============================================================================
-- Polya — pg_cron sweeper (explicitly requested): resume imports server-side
-- even if a worker dies while the student is away. Every minute, for each user
-- with an importing course, try to acquire the worker lease (succeeds ONLY when
-- no live worker holds it) and, if won, ping the pump. Reuses the single-flight
-- lease so a healthy worker is never double-kicked. pg_net makes the call; the
-- low-privilege pump secret in Vault authenticates it, and the public anon key
-- passes the JWT gateway — no user data, no service-role key in the DB.
--
-- Applied to remote via MCP apply_migration. Locally the sweeper is a no-op (no
-- pump secret in the local Vault → it returns early), so a dev stack never pings
-- prod.
-- ============================================================================
create extension if not exists pg_cron;

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
    select distinct user_id
    from public.polya_courses
    where import_status = 'importing'
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

-- Every minute. cron.schedule upserts by job name, so re-applying is safe.
select cron.schedule('polya-import-sweeper', '* * * * *', $$select public.polya_sweep_stalled_imports()$$);
