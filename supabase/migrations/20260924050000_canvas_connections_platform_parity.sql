-- Local-stack parity with the shared project's platform Canvas connection
-- (platform-hardening Tasks 8.1 / 8.1b).
--
-- Polya's functions now read and write `canvas_connections` and log every use
-- of a stored token in `canvas_connection_audit` (_shared/connections.ts). In
-- the shared project both were created by
-- lectra-ios/backend/migrations/20260924034309_canvas_connections_platform.sql;
-- a local `supabase start` from this repo only runs these migrations, so it
-- needs them here too. Every step is guarded or idempotent, so this is a no-op
-- where the objects already exist (including after `canvas_connections`
-- becomes the table itself).

do $$
begin
  if to_regclass('public.canvas_connections') is null then
    alter table public.polya_canvas_connections
      add column if not exists last_used_at timestamptz;

    create view public.canvas_connections
    with (security_invoker = true)
    as
    select
      id,
      user_id,
      base_url,
      access_token_ciphertext,
      key_version,
      canvas_user_id,
      canvas_user_name,
      status,
      last_validated_at,
      last_used_at,
      created_at,
      updated_at
    from public.polya_canvas_connections;
  end if;
end $$;

revoke all on table public.canvas_connections from public, anon, authenticated;
grant select, insert, update, delete on table public.canvas_connections to service_role;

create table if not exists public.canvas_connection_audit (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid,
  host text,
  source text not null check (char_length(source) between 1 and 64),
  client text check (client is null or client in ('extension', 'lectra', 'polya')),
  action text not null check (action in ('connect', 'query', 'disconnect')),
  operation text check (operation is null or char_length(operation) <= 64),
  outcome text not null default 'started'
    check (outcome in ('started', 'ok', 'canvas_auth', 'canvas_http', 'canvas_unreachable', 'error')),
  canvas_status integer,
  pages integer check (pages is null or pages >= 0),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists canvas_connection_audit_user_created_idx
  on public.canvas_connection_audit (user_id, created_at desc);
create index if not exists canvas_connection_audit_created_idx
  on public.canvas_connection_audit (created_at);

alter table public.canvas_connection_audit enable row level security;
revoke all on table public.canvas_connection_audit from public, anon, authenticated;
grant select, insert, update, delete on table public.canvas_connection_audit to service_role;
