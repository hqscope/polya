-- ============================================================================
-- Polya on iMessage — fixes Noel reports by text.
--
-- When Noel tells Polya that something it texted was wrong, the agent saves a
-- short lesson here and files the fix with scope-ops, whose cloud agent opens a
-- pull request. The lesson applies in Noel's own conversations right away and
-- stops once the fix ships (merged) or its pull request is closed. scope-ops
-- reports the pull request back (status, head commit) so the agent can merge
-- exactly the commit Noel looked at.
--
-- Only the owner account (NOEL_HUB_POLYA_USER_ID) ever has rows. The agent
-- (service role) reads and writes them for that user_id, taken from the
-- session it runs in, never from the model.
--
-- RLS on, zero policies, zero grants for anon/authenticated: service role only.
-- Additive-only; polya_ objects only.
-- ============================================================================

create table if not exists public.polya_imessage_fixes (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  lesson text not null check (char_length(lesson) between 1 and 400),
  status text not null default 'filed'
    check (status in ('filed', 'pr_ready', 'needs_noel', 'failed', 'shipped', 'closed')),
  issue_ref text check (issue_ref ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+$'),
  issue_url text check (issue_url ~ '^https://github\.com/'),
  pr_url text check (pr_url ~ '^https://github\.com/'),
  pr_number integer check (pr_number > 0),
  head_sha text check (head_sha ~ '^[0-9a-f]{40}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists polya_imessage_fixes_issue_ref_key
  on public.polya_imessage_fixes (issue_ref);

create index if not exists polya_imessage_fixes_user_status_idx
  on public.polya_imessage_fixes (user_id, status, created_at desc);

comment on table public.polya_imessage_fixes is
  'Mistakes the owner reported to the iMessage agent by text: the lesson it follows meanwhile and the scope-ops fix (issue, pull request, head commit). Service role only.';

alter table public.polya_imessage_fixes enable row level security;
revoke all on table public.polya_imessage_fixes from anon, authenticated;
