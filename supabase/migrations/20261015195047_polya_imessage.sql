-- ============================================================================
-- Polya on iMessage — account links, one-time link codes, check-in dedupe.
--
-- Students text Polya from iMessage. An unknown sender gets a one-time link
-- (`/connect/imessage?code=...`); the signed-in student confirms it on the web
-- page, which first shows which phone the link is for
-- (polya_imessage_peek_code, read-only) and then calls
-- polya_imessage_claim_code. The iMessage agent (its own Vercel project,
-- service role) reads the link to know whose courses to use, and records each
-- check-in it sends so a re-run never texts twice.
--
-- Every table: RLS on, zero policies, zero grants for anon/authenticated —
-- service role only. The exceptions are the peek and claim RPCs, which
-- authenticated students may execute and which act only on auth.uid().
--
-- Additive-only; polya_ objects only; applied remotely via MCP apply_migration
-- only, after a local `supabase db reset` (CLAUDE.md hard rules).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Links: one iMessage handle per Polya account, one account per handle.
-- `handle` is normalized by the agent (E.164 phone or lowercase email).
-- ---------------------------------------------------------------------------
create table if not exists public.polya_imessage_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  handle text not null unique,
  thread_id text,
  timezone text not null default 'America/Los_Angeles',
  check_ins_enabled boolean not null default true,
  quiet_start smallint not null default 22 check (quiet_start between 0 and 23),
  quiet_end smallint not null default 8 check (quiet_end between 0 and 23),
  linked_at timestamptz not null default now()
);

comment on table public.polya_imessage_links is
  'iMessage handle linked to a Polya account. Service role only; written by polya_imessage_claim_code.';
comment on column public.polya_imessage_links.thread_id is
  'Messaging thread id, saved by the agent on the first message after linking; reset when the handle changes.';
comment on column public.polya_imessage_links.quiet_start is
  'Local hour (in `timezone`) from which check-ins are not sent, until quiet_end.';

alter table public.polya_imessage_links enable row level security;
revoke all on table public.polya_imessage_links from anon, authenticated;

-- ---------------------------------------------------------------------------
-- One-time link codes. Only the sha256 hex of the code is stored; the code
-- itself exists only in the link texted to the student. 15-minute expiry is
-- set by the agent on insert.
-- ---------------------------------------------------------------------------
create table if not exists public.polya_imessage_link_codes (
  code_hash text primary key,
  handle text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create index if not exists polya_imessage_link_codes_handle_idx
  on public.polya_imessage_link_codes (handle);

comment on table public.polya_imessage_link_codes is
  'One-time iMessage link codes: sha256 hex of the code, never the code. Service role only.';

alter table public.polya_imessage_link_codes enable row level security;
revoke all on table public.polya_imessage_link_codes from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Check-ins sent. The unique key is the dedupe: the sender inserts first and
-- texts only if its insert won, so overlapping or repeated runs are safe.
-- ---------------------------------------------------------------------------
create table if not exists public.polya_imessage_check_ins (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.polya_sources(id) on delete cascade,
  kind text not null check (kind in ('due_soon', 'due_today', 'new_assignment')),
  sent_at timestamptz not null default now(),
  unique (user_id, source_id, kind)
);

-- The unique key leads with user_id; deleting a source cascades by source_id.
create index if not exists polya_imessage_check_ins_source_idx
  on public.polya_imessage_check_ins (source_id);

comment on table public.polya_imessage_check_ins is
  'iMessage check-ins already sent, one per (student, assignment, kind). Service role only.';

alter table public.polya_imessage_check_ins enable row level security;
revoke all on table public.polya_imessage_check_ins from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Check-in sweep: a linked student's assignments by due date (and the
-- new-assignment pass, which reads the same rows). No due_at index existed.
-- ---------------------------------------------------------------------------
create index if not exists polya_sources_assignment_due_idx
  on public.polya_sources (user_id, due_at)
  where origin = 'canvas_assignment';

-- ---------------------------------------------------------------------------
-- Peek at a link code before claiming it, so the confirm screen can say which
-- phone it links ("the phone ending in 0100"). A student tricked into opening
-- someone else's link sees a number that isn't theirs. Read-only: it never
-- marks, links or deletes anything.
--
-- Returns the handle's last 4 digits for a phone, or 'email' for an Apple ID
-- email (whose last 4 characters would tell the student nothing). An unusable
-- code raises the same `hint` keys as the claim below.
-- ---------------------------------------------------------------------------
create or replace function public.polya_imessage_peek_code(code text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_handle text;
  v_expires_at timestamptz;
  v_used_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Sign in to Polya before linking a phone.'
      using errcode = '42501', hint = 'polya_imessage_signed_out';
  end if;

  if code is null or code !~ '^[A-Za-z0-9_-]{6,128}$' then
    raise exception 'This link code is not valid.'
      using errcode = '22023', hint = 'polya_imessage_code_invalid';
  end if;

  select c.handle, c.expires_at, c.used_at
    into v_handle, v_expires_at, v_used_at
    from public.polya_imessage_link_codes as c
   where c.code_hash = encode(sha256(convert_to(code, 'UTF8')), 'hex');

  if not found then
    raise exception 'This link code is not valid.'
      using errcode = 'P0002', hint = 'polya_imessage_code_invalid';
  end if;

  if v_used_at is not null then
    raise exception 'This link code was already used.'
      using errcode = 'P0001', hint = 'polya_imessage_code_used';
  end if;

  if v_expires_at <= now() then
    raise exception 'This link code has expired.'
      using errcode = 'P0001', hint = 'polya_imessage_code_expired';
  end if;

  if v_handle ~ '^[+][0-9]{8,15}$' then
    return right(v_handle, 4);
  end if;
  return 'email';
end;
$$;

revoke all on function public.polya_imessage_peek_code(text) from public, anon, authenticated;
grant execute on function public.polya_imessage_peek_code(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Claim a link code for the signed-in student (called from the Polya web
-- page with the student's session). Hashes the code, claims it only if it is
-- unexpired and unused, then links its handle to auth.uid(), taking the
-- handle from any other account that held it. Returns the handle's last 4
-- characters for the confirmation screen.
--
-- Errors carry a stable `hint` the page maps to its states:
--   polya_imessage_signed_out | polya_imessage_code_invalid |
--   polya_imessage_code_used  | polya_imessage_code_expired
--
-- Confirming the same code twice as the same student (reload, double tap)
-- returns the last 4 again instead of failing.
-- ---------------------------------------------------------------------------
create or replace function public.polya_imessage_claim_code(code text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_hash text;
  v_handle text;
  v_used_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'Sign in to Polya before linking a phone.'
      using errcode = '42501', hint = 'polya_imessage_signed_out';
  end if;

  -- Same shape the web page accepts: URL-safe characters only.
  if code is null or code !~ '^[A-Za-z0-9_-]{6,128}$' then
    raise exception 'This link code is not valid.'
      using errcode = '22023', hint = 'polya_imessage_code_invalid';
  end if;

  v_hash := encode(sha256(convert_to(code, 'UTF8')), 'hex');

  select c.handle
    into v_handle
    from public.polya_imessage_link_codes as c
   where c.code_hash = v_hash;

  if not found then
    raise exception 'This link code is not valid.'
      using errcode = 'P0002', hint = 'polya_imessage_code_invalid';
  end if;

  -- Serialize every claim for one handle before touching its rows, so two
  -- accounts claiming different codes for it at once can't collide on the
  -- unique handle or deadlock on each other's code rows.
  perform pg_advisory_xact_lock(hashtext('polya_imessage_link:' || v_handle));

  update public.polya_imessage_link_codes as c
     set used_at = now()
   where c.code_hash = v_hash
     and c.used_at is null
     and c.expires_at > now();

  if not found then
    select c.used_at
      into v_used_at
      from public.polya_imessage_link_codes as c
     where c.code_hash = v_hash;

    -- Gone since the first read: another claim for this handle dropped it.
    if not found then
      raise exception 'This link code is not valid.'
        using errcode = 'P0002', hint = 'polya_imessage_code_invalid';
    end if;

    if v_used_at is not null then
      if exists (
        select 1
          from public.polya_imessage_links as l
         where l.user_id = v_user_id
           and l.handle = v_handle
      ) then
        return right(v_handle, 4);
      end if;

      raise exception 'This link code was already used.'
        using errcode = 'P0001', hint = 'polya_imessage_code_used';
    end if;

    raise exception 'This link code has expired.'
      using errcode = 'P0001', hint = 'polya_imessage_code_expired';
  end if;

  -- A handle belongs to one account: the newest confirmed claim takes it.
  delete from public.polya_imessage_links as l
   where l.handle = v_handle
     and l.user_id <> v_user_id;

  insert into public.polya_imessage_links as l (user_id, handle)
  values (v_user_id, v_handle)
  on conflict (user_id) do update
    set handle = excluded.handle,
        -- A different phone is a different conversation thread.
        thread_id = case when l.handle = excluded.handle then l.thread_id end,
        linked_at = now();

  -- Any other outstanding code for this handle is now pointless; drop it so
  -- it can't relink the handle later.
  delete from public.polya_imessage_link_codes as c
   where c.handle = v_handle
     and c.code_hash <> v_hash;

  return right(v_handle, 4);
end;
$$;

revoke all on function public.polya_imessage_claim_code(text) from public, anon, authenticated;
grant execute on function public.polya_imessage_claim_code(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Retrieval for the iMessage agent. It runs as service role, where auth.uid() is null, so the
-- auth.uid()-scoped polya_match_units / polya_search_units_fts return nothing. These twins are
-- copied from 20260717210000_polya_init.sql with one change: they filter by p_user_id. Only
-- service_role may execute them (Supabase grants execute to everyone by default, so the revoke
-- is what stops a signed-in user from reading another student's materials). Keep in step with
-- the originals.
-- ---------------------------------------------------------------------------
create or replace function public.polya_match_units_for_user(
  p_user_id uuid,
  p_course_id uuid,
  p_query_embedding extensions.vector(1536),
  p_limit integer default 12,
  p_exclude_roles text[] default '{}'::text[]
)
returns table (
  unit_id uuid,
  source_id uuid,
  unit_type text,
  content_role text,
  ordinal integer,
  heading_path text,
  page_start integer,
  page_end integer,
  t_start_ms integer,
  t_end_ms integer,
  procedure_id uuid,
  step_number integer,
  title text,
  content text,
  score real
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    u.id as unit_id,
    u.source_id,
    u.unit_type,
    u.content_role,
    u.ordinal,
    u.heading_path,
    u.page_start,
    u.page_end,
    u.t_start_ms,
    u.t_end_ms,
    u.procedure_id,
    u.step_number,
    s.title,
    u.content,
    (1 - (u.embedding <=> p_query_embedding))::real as score
  from public.polya_content_units u
  join public.polya_sources s on s.id = u.source_id
  where u.user_id = p_user_id
    and u.course_id = p_course_id
    and u.embedding is not null
    and not (u.content_role = any(coalesce(p_exclude_roles, '{}'::text[])))
  order by u.embedding <=> p_query_embedding
  limit greatest(1, least(coalesce(p_limit, 12), 24));
$$;

revoke all on function public.polya_match_units_for_user(uuid, uuid, extensions.vector, integer, text[])
  from public, anon, authenticated;
grant execute on function public.polya_match_units_for_user(uuid, uuid, extensions.vector, integer, text[])
  to service_role;

create or replace function public.polya_search_units_fts_for_user(
  p_user_id uuid,
  p_course_id uuid,
  p_query text,
  p_limit integer default 12,
  p_exclude_roles text[] default '{}'::text[]
)
returns table (
  unit_id uuid,
  source_id uuid,
  unit_type text,
  content_role text,
  ordinal integer,
  heading_path text,
  page_start integer,
  page_end integer,
  t_start_ms integer,
  t_end_ms integer,
  procedure_id uuid,
  step_number integer,
  title text,
  content text,
  score real
)
language sql
stable
security invoker
set search_path = public
as $$
  with query as (
    select websearch_to_tsquery(
      'english',
      coalesce(nullif(trim(p_query), ''), 'course materials')
    ) as tsq
  )
  select
    u.id as unit_id,
    u.source_id,
    u.unit_type,
    u.content_role,
    u.ordinal,
    u.heading_path,
    u.page_start,
    u.page_end,
    u.t_start_ms,
    u.t_end_ms,
    u.procedure_id,
    u.step_number,
    s.title,
    u.content,
    ts_rank(u.search_vector, query.tsq)::real as score
  from public.polya_content_units u
  join public.polya_sources s on s.id = u.source_id
  cross join query
  where u.user_id = p_user_id
    and u.course_id = p_course_id
    and not (u.content_role = any(coalesce(p_exclude_roles, '{}'::text[])))
    and u.search_vector @@ query.tsq
  order by score desc, u.ordinal asc
  limit greatest(1, least(coalesce(p_limit, 12), 24));
$$;

revoke all on function public.polya_search_units_fts_for_user(uuid, uuid, text, integer, text[])
  from public, anon, authenticated;
grant execute on function public.polya_search_units_fts_for_user(uuid, uuid, text, integer, text[])
  to service_role;
