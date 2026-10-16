-- ============================================================================
-- Polya on iMessage — a student's Gradescope connection.
--
-- Gradescope has no public API, so the iMessage agent signs in the way a
-- browser does and reads the student's own course pages (assignments, due
-- dates, whether they submitted). One row per student holds that sign-in:
-- session cookies, and for password accounts the password so an expired
-- session can sign in again. Both are AES-256-GCM sealed by the agent
-- (GRADESCOPE_SECRET_KEY, `key_version` names the key) before they get here;
-- the database never sees plaintext. Rows are written by
-- imessage/scripts/gradescope-connect.ts and refreshed by the agent.
--
-- RLS on, zero policies, zero grants for anon/authenticated: service role only.
-- Additive-only; polya_ objects only. Not applied: per CLAUDE.md, rename with a
-- fresh UTC timestamp at apply time, run a local `supabase db reset`, then
-- apply via MCP apply_migration.
-- ============================================================================

create table if not exists public.polya_gradescope_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  session_ciphertext text not null,
  password_ciphertext text,
  key_version smallint not null default 1,
  verified_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

comment on table public.polya_gradescope_connections is
  'A student''s Gradescope sign-in for the iMessage agent: sealed session cookies and optional sealed password. Service role only.';

alter table public.polya_gradescope_connections enable row level security;
revoke all on table public.polya_gradescope_connections from anon, authenticated;
