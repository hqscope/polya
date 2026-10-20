# Polya on iMessage

An [eve](https://eve.dev) agent that students text for classwork help. It follows the same study rules as Polya on the web: each course's mode (Open, Guided, Practice, Review) decides how much help is allowed, explanations are grounded in the student's own course materials, and it never sends a bare answer. A background loop also texts short check-ins about upcoming, newly posted, and newly graded assignments that offer to help plan, start, or review, never to do the work.

This is its own deployable, separate from the Polya web app and from the scope-ops iMessage agent. It has its own Photon project, its own Vercel project (Root Directory `imessage`), and its own `package.json`.

## Layout

```text
agent/
  agent.ts                 model (direct Anthropic, claude-haiku-5-5); eve's default tools off
  instructions/
    check-ins.md           how to word a "[polya check-in]" message
    core.md                who Polya is on iMessage and how it helps
  channels/
    photon.ts              iMessage channel: linking, daily cap, auth for every turn (default export)
    check-ins.ts           POST /polya/check-ins/run, bearer POLYA_CHECKINS_SECRET
    gradescope-connect.ts  POST /polya/gradescope/connect, bearer POLYA_CONNECT_SECRET (askpolya.com connect page)
  schedules/check-ins.ts   check-in loop on a cron
  memory/notes.ts          long-range notes per student (notes__save / notes__remove), see lib/notes-memory.ts
  tools/                   the only authored tools the model has
    list_courses.ts
    get_course_rules.ts
    search_course_materials.ts
    upcoming_assignments.ts
    check_in_settings.ts
    recent_study_history.ts  read-only: the student's recent Polya web conversations
    no_reply.ts            lets a check-in turn stay silent (eve's no_reply)
    reconnect_link.ts      link to connect or reconnect Gradescope or Canvas, plus whether it works now
    unlink.ts              asks the student to confirm first (approval: always())
  lib/                     shared code; the pure modules are covered by test/
test/                      node --test, pure logic only
```

eve composes `instructions/` in filename order, so `check-ins.md` comes before `core.md`. Both are system instructions and are written to stand alone.

## Environment

Names only; see `.env.example`. Never commit values.

| Name | Used for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude, called directly through `eve/models/anthropic` |
| `IMESSAGE_PROJECT_ID`, `IMESSAGE_PROJECT_SECRET` | Photon project credentials, read on first use |
| `IMESSAGE_WEBHOOK_SECRET` | Photon webhook signing secret. If it is unset when the channel module loads, the channel falls back to Vercel OIDC verification, which rejects direct Photon webhooks |
| `POLYA_SUPABASE_URL`, `POLYA_SUPABASE_SERVICE_ROLE_KEY` | Shared Scope Supabase project, service role |
| `POLYA_APP_URL` | Base for link pages, default `https://askpolya.com` |
| `POLYA_CHECKINS_SECRET` | Bearer secret for the check-in trigger route |
| `POLYA_CONNECT_SECRET` | Bearer secret the askpolya.com connect page sends to `POST /polya/gradescope/connect`; at least 32 characters |
| `GRADESCOPE_SECRET_KEY` | Seals stored Gradescope sessions and passwords (32 bytes, base64) |
| `GEMINI_API_KEY` | Query embeddings for course search, if search uses them |
| `POLYA_IMESSAGE_DAILY_REPLY_CAP` | Replies per student per UTC day, default 60 |
| `NOEL_HUB_URL`, `NOEL_HUB_TOKEN`, `NOEL_HUB_POLYA_USER_ID` | Noel's personal hub (read-only MCP) in his own conversation, and his personal digest. Unset turns both off |

## How a message is handled

Every inbound iMessage goes through `onMessage` in `agent/channels/photon.ts` before any model call:

1. Drop empty events, our own echoes, bots, and **group chats**. A link code posted in a group could be claimed by anyone in it, and one shared session would mix several students' courses.
2. Normalize the sender (`lib/handles.ts`) and look up `polya_imessage_links` by handle.
3. **Not linked:** post a one-time link straight to the thread with the Chat SDK thread's `post()` and return `null`, so no model turn runs. See [Linking](#linking).
4. **Linked:** save the thread id when the link has none (or a different one). The check-in sender needs it.
5. Count the message against the daily cap. Under the cap, dispatch with `defaultPhotonAuth(message)` plus the `polyaUserId` attribute, and a context line with the student's local time. Over the cap, post one notice, then stay quiet until the reset.

Tools resolve the student with `requireStudentId(ctx.session.auth)` and filter every query by that `user_id`. The model never supplies a user id. Course ids from the model only resolve if they belong to that student (`lib/courses.ts`).

Long-range memory (`memory/notes.ts`) is scoped the same way: the slot's scope is the `polyaUserId` attribute, and its provider reads and writes `polya_imessage_notes` only for that `user_id`. A session without it (unlinked, local dev) gets no memory. The table comes from `supabase/migrations/20261015195830_polya_imessage_notes.sql`; until it's applied, recall returns nothing and saves report that notes aren't available, so turns never fail on memory. eve's built-in `fileMemory()` was skipped because on Vercel it needs a provisioned Blob store and throws without one.

## Linking

1. An unknown sender texts Polya. The channel creates a code (24 random bytes, base64url, 32 characters), stores only `sha256(code)` as lowercase hex in `polya_imessage_link_codes` with a 15-minute expiry, and texts `${POLYA_APP_URL}/connect/imessage?code=<code>`.
2. The student opens the link, signs in to Polya, and confirms. The page calls `polya_imessage_claim_code(code)`, which hashes the code the same way, marks it used, and upserts `polya_imessage_links` for `auth.uid()`.
3. Their next text finds the link and is answered normally.

A handle holds at most 3 live codes. Past that, the sender is told to use the link they already have. Each new code also sweeps codes that expired more than a day ago. Earlier live codes stay valid; the claim RPC deletes the rest once one is used.

"Stop" or "pause check-ins" turns check-ins off (`check_in_settings`). "Unlink" or "disconnect" removes the link (`unlink`), after the student replies `1` (Approve) to eve's numbered confirmation. A reply in words that isn't an option ("yes") withdraws the confirmation instead of answering it; `core.md` tells the model to ask again.

## Daily reply cap

Each dispatched message calls the shared `increment_usage_daily(user_id, 'polya-imessage:reply', 1)` RPC, the same per-user, per-UTC-day meter Polya's edge functions use (`usage_daily`, from lectra-ios `20260924022256_shared_rate_limit.sql`). No new table. If the meter errors, the student gets a "can't reply right now" message (fail closed, like Polya's other limiters). Check-in turns aren't counted; only inbound student messages are.

The local Polya Supabase stack doesn't include that shared migration, so against a local database every linked message is refused until the function exists there.

## Reconnect links

When a student's Gradescope sign-in or Canvas connection stops working, the check-in run texts them a link to fix it (`lib/reconnect.ts`):

- Gradescope is broken when reading it fails with `session_expired`, `invalid_credentials`, or `sso_required`; the failure is saved as `<code>: <message>` in `polya_gradescope_connections.last_error`. Canvas is broken when the student's connections include an `invalid` one and no `active` one (read through `canvas_connections`, the name Polya's edge functions use).
- Links: `${POLYA_APP_URL}/connect/gradescope` and `${POLYA_APP_URL}/app/connect`. The hand-off starts with `[polya reconnect]` (`instructions/check-ins.md`).
- At most one text per service per 24 hours while it stays broken, same students and quiet hours as check-ins. `polya_imessage_reconnect_notices` records each text and is claimed before sending; a row is deleted once the service works again or the student reconnects. Until that table exists (`supabase/migrations/20261016034944_polya_imessage_reconnect_notices.sql`), nothing is texted.
- Students can ask for the link any time (`reconnect_link`).
- The web page signs students in through `POST /polya/gradescope/connect` (`lib/gradescope/connect.ts` documents the request and response shapes). A successful connect clears the notice and hands `[polya reconnect]` with `status: reconnected` to the student's thread.

## Personal digest (hub owner only)

The check-in run ends with a pass for one account: the hub owner (`NOEL_HUB_POLYA_USER_ID`), and only while that account has a thread and check-ins on (`lib/hub-digest*.ts`). It never loads anyone else's link.

- **Reads, in code, read tools only:** `hub_connections` (which Google accounts), `gmail_search` (`is:unread in:inbox newer_than:2d` minus the promotions, social, updates, and forums categories, 10 per account), `canvas_announcements` (last 48 hours), and `calendar_list_events` (next 3 hours). `lib/noel-hub-client.ts` refuses any tool outside `DIGEST_HUB_TOOLS`. Only sender, subject, time, and a snippet of at most 200 characters reach the hand-off; nothing from the hub is logged.
- **Digest:** new items go to the owner's thread as one `[polya digest]` hand-off, fenced as data. The agent texts only what matters or calls `no_reply` (`instructions/check-ins.md`). Calendar events are digested once, while they start within 60 minutes. At most 6 digests per local day.
- **Morning brief:** the first run from 8:00 local, outside quiet hours and before noon, hands off `[polya morning brief]` instead: events left today, assignments due in 3 days that aren't done (the `upcoming_assignments` loader), and new mail and announcements. It claims those items so the digest doesn't repeat them, and doesn't count against the 6.
- **Dedupe:** `polya_imessage_hub_seen` (`supabase/migrations/20261020195214_polya_imessage_hub_seen.sql`) holds `gmail:<id>`, `canvas:<announcement id>`, `cal:<event id>:<start>`, `brief:<date>`, and one `digest:sent:<time>` row per digest (the daily cap counts those). Keys are claimed before the hand-off and released if it fails. Until the table exists, the pass reads nothing and logs that once per process.
- Quiet hours and "pause check-ins" apply to the digest and the brief too.

## Run locally

```bash
npm install
cp .env.example .env.local   # fill in values; don't commit
npx eve dev
```

`eve dev` serves the Photon webhook at `/eve/v1/photon`. Photon needs a public URL to reach it, so use a tunnel and point a Photon webhook at `https://<tunnel>/eve/v1/photon`, or test the agent through the dev terminal UI. That path has no Photon sender, so tools fail with "isn't linked" unless the session auth carries `polyaUserId`.

Photos students send are staged in the session sandbox before the model sees them. Locally, eve looks for Docker, then microsandbox, then just-bash. With none available, `eve build` fails at sandbox prewarm; `npx eve build --skip-sandbox-prewarm` builds everything else. On Vercel, the default is Vercel Sandbox.

## Tests and checks

```bash
npm test           # node --test "test/*.test.ts"
npm run typecheck  # tsc
```

`agent/lib/study-rules.ts` is a copy of `polya/supabase/functions/_shared/study-rules.ts`, because this deployable can't import outside its folder. `test/study-rules.test.ts` compares the two whenever the whole polya repo is checked out. Change both together.

## Deploy (own Vercel project)

1. Create a Vercel project from the polya repo with **Root Directory** `imessage` and Node 24. eve's build writes the Vercel output (`.vercel/output`) during a hosted build.
2. Set the environment variables above as encrypted variables for Production.
3. Deploy (Git push or `eve deploy` from this folder).
4. In the Photon project for Polya's number, create a webhook for `https://<production-domain>/eve/v1/photon` and copy its signing secret into `IMESSAGE_WEBHOOK_SECRET`. Redeploy so the channel picks it up.
5. Check `https://<production-domain>/eve/v1/health`.

Notes:

- Vercel Deployment Protection must not cover the production domain the Photon webhook calls.
- The check-in schedule's cron cadence needs Vercel Pro if it runs more often than daily (Hobby allows one cron per day). `POST /polya/check-ins/run` runs the same idempotent loop for an external cron.
- The default eve HTTP session API (`/eve/v1/session`) stays mounted with eve's fail-closed route auth (same-project Vercel OIDC, local dev). Students never use it. Export `disableRoute()` from `agent/channels/eve.ts` to remove it if the dev terminal isn't needed against production.
