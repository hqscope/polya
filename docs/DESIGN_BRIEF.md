# Polya — design brief (for a design/frontend agent)

Read this before designing anything. It describes what Polya is, the exact screens that exist, the
real data and API each screen has, and the interaction models the design **must** honor so the UI
plugs into the working backend instead of assuming endpoints or data that don't exist.

Live at **askpolya.com**. Repo: `02-Subsidiaries/polya`. Stack: Next.js 16 (App Router) · React 19 ·
Tailwind 4 (CSS-first `@theme`) · strict TypeScript · `@supabase/ssr` · `lucide-react` icons. No
component library — everything is hand-rolled with Tailwind + a few CSS classes (see §7).

---

## 1. What Polya is (design the story, not a generic chatbot)

**"Understand it, don't just submit it."** A student connects a course from their school's
Canvas; Polya reads the actual materials (readings, slides, pages, lecture transcripts) and becomes
a tutor that:

- **Answers with receipts** — every claim carries a citation that opens the exact page/slide/lecture
  moment it came from. Never a black-box answer.
- **Teaches instead of finishing** — for a "solve this" request it gives a hint, then a step, then a
  worked analogy — not the answer. (The "help ladder.")
- **Follows the instructor's rules** — a per-course policy (Open / Guided / Practice / Review)
  visibly changes how much Polya reveals. This is the university-sale story.

The three things above are the **differentiators to elevate** — a design that makes them feel
first-class beats a prettier ChatGPT clone. The generic-chatbot parts (a text box, streaming bubbles)
are table stakes; the source-viewer coupling, the "I'm stuck" ladder, and the policy control are what
make Polya *Polya*.

**Voice / copy rule (hard):** user-facing text describes the experience, never the plumbing. Never
say "RAG", "embedding", "vector", "edge function", "chunk". ("Canvas access token" is fine — it's
Canvas's own term.) Current tone is warm, plain, second-person.

---

## 2. Routes that exist (what to design)

| Route | What it is | Design priority |
|---|---|---|
| `/` | Marketing landing. Currently a headline + 3 feature cards + footer. | Conversion surface — highest visual investment |
| `/login` | Google sign-in card. | Small, polished |
| `/app` | The signed-in home: a grid of the student's courses, or an empty state → "Connect Canvas". | Medium |
| `/app/connect` | 3-step flow: paste Canvas URL+token → pick a course → watch import progress. | Medium-high (first-run; sets the tone) |
| `/app/courses/[id]` | **THE core screen** — the study chat + source panel. | Highest — this is the product |
| `/app/courses/[id]/materials` | Instructor policy control + transcript upload + list of imported materials. | Medium (the differentiator lives here) |

Auth routes (`/auth/login`, `/auth/callback`, `/auth/signout`) are redirect-only, no UI.
The `/app/*` area is wrapped by a shell layout with a left sidebar (logo, "My courses", "Connect
Canvas", signed-in user + sign-out).

---

## 3. The core screen in detail — `/app/courses/[id]` (component: `ChatView`)

Current layout: two columns — a chat card (left, flex-1) and a source aside (right, ~20rem). This is
the screen to get right.

**What the student does:** types a question (or taps "I'm stuck"), watches Polya answer, clicks a
citation to see the source.

**Interaction model the design MUST honor:**

1. **Streaming.** The answer arrives token-by-token. Before any text, a `sources` list arrives (the
   evidence Polya is about to cite). Design needs: an idle/empty state, a "thinking" state (brief),
   and a streaming state (text growing, cursor/indicator).
2. **Citations are the point.** Assistant prose contains `[1]`, `[2]` markers rendered as small
   pills. Clicking a pill (or a source in the rail) **opens that source in the right panel** — a PDF
   at the exact page, or a page/transcript's text. The right column toggles between:
   - **Source rail** (default): the numbered list of sources behind the current answer, each with
     title, location ("p.4" / "13:32–14:33"), and a snippet.
   - **Source viewer** (when one is opened): the PDF page (native viewer in an iframe today — a
     designer could upgrade to an in-page renderer with snippet highlight) or the formatted text,
     with a "← Sources" back affordance.
3. **The help ladder.** An "I'm stuck" control (currently a small button by the input) sends a
   nudge; Polya escalates help one level. The design should make "get more help" feel encouraged,
   not like failure.
4. **Conversations.** Messages persist; a course can have multiple conversations (there's a
   `title` and `last_message_at`). Today there's no conversation switcher UI — **an opportunity**: a
   conversation list/sidebar would be a natural, real addition (the data exists).

**Data available to this screen** (all RLS-scoped to the signed-in user, read via Supabase client):
- Course: `{ id, name, code, term_name }`
- Conversation history: `polya_messages` → `{ role: "user"|"assistant", content, sources }`
- Live stream (see §5 for exact events).

---

## 4. The other screens' data

**`/app` (course list):** `polya_courses` → `{ id, name, code, term_name, import_status }`.
Empty state when none. Each card links to `/app/courses/[id]`.

**`/app/connect` (import):** three stages in one client component (`ConnectFlow`):
- **Token form** — Canvas base URL + access token, with a "where do I find this?" helper.
- **Course picker** — list of the student's real Canvas courses `{ canvas_course_id, name, code,
  term_name }`.
- **Import progress** — a `progress` object `{ total, queued, fetching, parsing, embedding, ready,
  failed, skipped, needs_ocr }` plus a per-source list `{ title, status }`. Updates as a loop runs
  (see §5). Needs a satisfying progress UI (this is the "it's working" moment).

**`/app/courses/[id]/materials`:**
- **Policy panel** — four modes (Open / Guided / Practice / Review) + an optional free-text "note to
  the tutor". Writes `polya_course_policies`. Styled as an *instructor* control (the demo flips modes
  and re-asks to show behavior change). This is the university differentiator — worth making it feel
  authoritative.
- **Transcript upload** — a file picker (.txt/.json/.vtt/.srt) → uploads → processes. Copy is
  student-facing ("Have a lecture recording? Add its transcript…").
- **Materials list** — every imported source with a status label (Ready / Working / Scanned—skipped).

---

## 5. Backend API contracts (so the design maps to real calls)

The frontend talks to four Supabase edge functions. All take a user JWT (from the Supabase session)
and JSON, except the tutor which streams. Helpers already exist: `src/lib/functions.ts`
(`invokeFunction`) and `src/lib/sse.ts` (`streamTutor`).

**`polya-tutor` — the chat (Server-Sent Events).** Request `{ course_id, message, conversation_id?,
attempt? }`. Response is an SSE stream, in this order:
```
event: sources   data: { sources: [{ n, title, unit_type, page_start, t_start_ms, snippet, ... }],
                         conversation_id, policy_mode }
event: delta     data: { text: "…" }        // many of these — the answer, token by token
event: done      data: { message_id }
event: error     data: { error: "…" }       // on failure
```
Design implication: **sources render before text; text streams in.** A source has either a page
(`page_start`/`page_end`) or a transcript time (`t_start_ms`/`t_end_ms`) — the UI shows "p.4" or
"13:32–14:33" accordingly.

**`polya-import` — connect flow (JSON, client-pumped).** Actions: `start` (enumerate a course →
`{ course_id, source_count }`), `process` (advance one step → `{ done, status, progress }` — the UI
calls this in a loop until `done`), `status` (`{ progress, sources }`), `add_upload` (register a
transcript). The progress loop is why the import screen animates over a few seconds.

**`polya-canvas` — Canvas connection (JSON).** `connect` (validate + save token →
`{ connection_id, canvas_user_name }`), `list_courses` (→ real courses), `status`, `disconnect`.
The access token is never returned to the client after entry.

**`polya-search` — retrieval as JSON** (used by tooling; a designer could use it for a "related
passages" feature).

---

## 6. Sign-in & production note (affects whether the deployed site works)

Auth is Google OAuth via Supabase (project `vcadcdgnwxjlgaoqktkd`, shared with the Canvascope
extension). For **askpolya.com** to sign users in, the domain's callback
(`https://askpolya.com/auth/callback`) must be in Supabase Auth's redirect allow-list **and** the
Google OAuth client's authorized redirect URIs, and `NEXT_PUBLIC_SITE_URL=https://askpolya.com`
should be set in the Vercel env (the code reads it in `src/lib/site.ts`). If sign-in bounces, that's
the cause — not a design issue.

---

## 7. Current design system (a starting point, not sacred)

`src/app/globals.css` defines a "pencil on graph paper" theme via Tailwind 4 `@theme`:
- **Paper** `#f7f4eb` / card `#fffdf7` · **ink** `#212b26` (soft `#55605a`, faint `#838d86`)
- **Brand** chalk-teal `#0c6b58` (deep `#084c3f`) · **secondary** amber `#b7791f` · danger `#a4361f`
- **Type:** serif display (`Iowan Old Style`/`Palatino`/`Georgia`), sans body. Faint graph-paper grid
  on `body`.
- **Classes:** `.card`, `.button-primary`, `.button-secondary`, `.eyebrow`, `.hairline`.

It's intentionally light and unopinionated — **you may evolve or replace it.** If you do, keep it a
system (tokens in `@theme`, reused classes), keep the warm/academic feel unless there's a reason to
pivot, and make the three differentiators (citations, ladder, policy) visually distinctive.

**What's minimal today and ripe for design:** the landing page, the streaming/idle/empty states of
the chat, the source viewer (plain iframe now), the import progress animation, empty states
everywhere, and motion (there is essentially none). No illustration or brand imagery exists yet.

---

## 8. Constraints for whoever implements the design

- Next 16 App Router: server components fetch data; anything interactive is a `"use client"`
  component. Data reads go through the RLS-scoped Supabase clients in `src/lib/supabase/*` — a
  student only ever sees their own rows, so design for the single-user case.
- Don't change the edge-function request/response shapes (§5) — design around them. New *read*
  surfaces can query `polya_*` tables directly via the client (RLS protects them).
- Keep the copy rule (§1): experience language, never mechanics.
- Icons: `lucide-react`. Keep bundle lean; inline SVG/data-URI for any custom art.
