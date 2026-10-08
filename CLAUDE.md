# Polya — repo conventions

Polya is a course-aware AI tutor web app (Next.js 16 + Supabase). Product thesis: guided help that
teaches — hints, steps, and worked analogies grounded in the student's actual course materials —
never a bare answer dump. See `docs/ARCHITECTURE.md` (system design) and `docs/POSITIONING.md`
(product narrative).

## Stack & commands

- Next.js 16 / React 19 / strict TypeScript / Tailwind 4 / `@supabase/ssr`; npm (no monorepo tooling).
- Backend = the **shared** Scope Supabase project `vcadcdgnwxjlgaoqktkd`: `polya_`-prefixed
  tables in `public`, Deno/TS edge functions in `supabase/functions/`, storage bucket `polya_documents`.
- `npm run dev` (webpack) · `lint` · `typecheck` · `test` (Node 22.6+ native TS test runner over
  `tests/`) · `eval` (retrieval recall) · `seed:fixture`.
- Local DB: `supabase start` / `supabase db reset` — the local stack contains ONLY Polya migrations
  and is self-contained on purpose (FKs go to `auth.users`, no dependence on sibling repos' schema).

## ⚠️ Shared-Supabase migration rules (HARD RULES)

The remote project's migration history is owned by THREE sibling repos (extension-core, Lectra's
FILE DROP PROTOCOL, and this one). Their local dirs have all drifted from remote history.

1. **NEVER** run `supabase db push`, `supabase db reset --linked`, `supabase migration repair`,
   or `supabase db pull` against the linked remote from this repo.
2. Apply remote changes ONLY via the Supabase MCP `apply_migration` tool (name = migration file
   basename, query = file contents), after the migration passed a local `supabase db reset`.
3. Migration filenames take a fresh UTC timestamp generated at apply time so they sort after the
   current remote head.
4. Migrations are **additive-only** once applied; never rewrite an applied migration file.
5. Never create, alter, or drop objects that don't start with `polya_` (tables, functions, buckets,
   policies). The extension's and Lectra's objects are off-limits, including `claude-proxy` and
   `gemini-proxy` (Polya has its own edge functions).

## Secrets & data

- Canvas access tokens live in `polya_canvas_connections` — RLS on, **zero** policies/grants for
  `authenticated`; only edge functions (service role) touch them. Tokens are never returned to the
  client after entry, never logged.
- `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / service-role key exist only in edge-function env.
- Only `.env.template` is committed. Real course files/dumps go under `data/` (gitignored —
  copyrighted material). The only committed corpus is the self-authored `fixtures/demo-course/`.

## Copy & code style

- User-facing copy (landing, app microcopy, error messages) describes the experience, never the
  mechanics — no "RAG", "pgvector", "edge function", "embedding", "token" (except "Canvas access
  token", which is Canvas's own term).
- Pure logic shared with edge functions lives in `supabase/functions/_shared/` as runtime-agnostic
  TS (no Deno globals in the pure modules) so Node's test runner can import it from `tests/`.
- Cite provenance in tutor output as `[n]` markers + a `sources[]` array — matches the extension's
  convention (`answer-render.js`).

## Autofix agent (scope-ops)

Bugs and tasks filed from Slack (or handed off from Claude) become GitHub issues here. Labeling an issue `claude:fix` starts
`.github/workflows/claude-fix.yml`, which runs Claude with `.github/claude/fix-prompt.md`.

- **Tests:** `npm test`. Run only the tests that cover the change.
- **Output:** a draft PR from `fix/<name>-<issue>` (bugs) or `feature/<name>-<issue>` (tasks) with Summary, Root cause, Changes,
  **Verified**, **Not verified**, and `Fixes #<issue>`. Noel merges. The agent never pushes to
  `main`, merges, or force-pushes.
- **Out of bounds** (comment `NEEDS-NOEL: <why>` and stop): migrations or `supabase/`, edge-function
  deploys, billing, auth flows, secrets, anything needing a dashboard or a device, workflow files,
  and user-facing copy that makes product claims.
- **Honesty:** list only checks that actually ran under Verified. Everything else goes under Not
  verified.
- **Copy:** UI strings describe the experience, not the mechanics. Product name is Scope;
  "Canvascope" only where it is already the legacy name.
- **Context:** `scope-docs/AGENT_BRIEFING.md` in hqscope/scope-docs.
