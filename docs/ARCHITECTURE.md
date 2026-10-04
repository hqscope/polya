# Polya — architecture (v1)

One product, three moving parts: a Next.js app (UI + auth), the shared Scope Supabase project
(data + storage + edge functions), and two external APIs (the student's Canvas, and the model
providers reached only from edge functions).

```
Next.js 16 app (this repo)                              Supabase (shared project vcadcdgnwxjlgaoqktkd)
┌─────────────────────────────────┐                     ┌──────────────────────────────┐
│ / landing · /app chat shell     │   user JWT (RLS)    │ polya_* tables (+pgvector)    │
│ /app/connect  token + import UI │ ──────────────────► │ storage: polya_documents      │
│ /app/courses/[id] + transcripts │                     │ edge functions (Deno/TS):     │
│ policy panel · source viewer    │   invoke (SSE)      │  polya-canvas  polya-import   │
└─────────────────────────────────┘ ──────────────────► │  polya-tutor   polya-search   │
        Canvas REST (user token) ◄─────────────────────  (Claude Sonnet 5 · Gemini emb) │
                                                        └──────────────────────────────┘
```

## Ingestion

1. **Connect** — the student pastes a Canvas personal access token (`/app/connect`). `polya-canvas`
   validates it against `/api/v1/users/self` and stores it in `polya_canvas_connections` — a table
   with RLS enabled and **no** policies for `authenticated`; only service-role edge functions can
   read it. The client never sees the token again.
   The Canvas base URL is an SSRF boundary (edge functions fetch it server-side with the stored
   token): `normalizeBaseUrl` enforces https and rejects IP literals, localhost, private-suffix
   hostnames (`.local`, `.internal`, `.home.arpa`), dotless names, userinfo, and nonstandard ports.
   Residual risk: this is hostname-pattern filtering only — DNS-resolution pinning / rebinding
   defense isn't practical in the edge runtime. `POLYA_TOKEN_KEY` (edge env only) encrypts tokens
   at rest with AES-256-GCM; legacy plaintext rows re-encrypt lazily on first use.
2. **Enumerate** — `polya-import {action:start}` lists course files (PDF filter), Pages, syllabus,
   assignment descriptions, and module structure via the Canvas REST API and creates one
   `polya_sources` row per item, status `queued`.
3. **Pump** — the import screen repeatedly calls `{action:process}`. Each call claims ONE bounded
   unit of work via `polya_claim_import_work()` (`for update skip locked`) and advances it a step:
   - `fetching` → download bytes → `polya_documents` storage (`{user}/{course}/{source}/original.ext`),
     sha256 recorded
   - `parsing` → PDF text per page via `unpdf` (Deno), ≤40 pages per invocation, cursor in
     `pages_parsed`; pages with <50 chars count as empty; >60% empty ⇒ `needs_ocr` (skipped in v1)
   - `chunking` → 1700-char chunks, 140 overlap, sentence-boundary snapping (port of the extension
     chunker) + heuristic procedure extraction (numbered-step decks → `polya_procedures` + steps)
   - `embedding` → Gemini `gemini-embedding-001`, `output_dimensionality: 1536`,
     `RETRIEVAL_DOCUMENT`, batches ≤96, **L2-re-normalized** (non-3072 outputs are not normalized
     by the API), written to `polya_content_units.embedding`
   The pump is resumable (all cursors persisted) and double-tab safe.
4. **Transcripts** — lecture transcripts live in Kaltura at our pilot school, so v1 accepts manual
   uploads (.txt, Kaltura .json, .vtt, .srt) on the course page; they parse into timed
   `transcript_segment` units. A Kaltura auto-fetch adapter is roadmap.

Re-import (`start` on an already-imported course, or "Check for updates" which passes `force`)
diffs enumeration against stored rows (`_shared/enumerate.ts`): new sources are queued; a source
whose `canvas_updated_at` moved (or any source, under `force`) is marked `needs_refresh` and
re-queued. The pump then re-fetches its bytes and compares `content_sha256` — unchanged content
keeps its existing units; changed content has its units and procedures cleared and rebuilt in the
same pass (only that one source is briefly un-searchable). Assignment `due_at` and titles are
patched in place when only metadata changed. `content_sha256` is also the future key for a shared
cross-user course index.

## Retrieval

Hybrid, per course, all RLS-scoped to the signed-in student:

- `polya_match_units(course_id, query_embedding, …)` — pgvector cosine, exact scan (corpora are
  10³–10⁴ units; add ANN only past ~50k)
- `polya_search_units_fts(course_id, query, …)` — `websearch_to_tsquery` over a generated tsvector
- Fusion in `_shared/retrieval.ts`: Reciprocal Rank Fusion (k=60, ported from the extension),
  vector-only hits below 0.25 cosine dropped unless they also matched lexically, capped at 8,
  then expanded: ±1 ordinal neighbors merged in; a `procedure_step` hit pulls its parent procedure
  and all sibling steps as one grouped source. `practice` mode excludes `solution_key` material at
  the SQL level (`p_exclude_roles`).

## Tutoring

`polya-tutor` streams SSE: first a `sources` event (the numbered evidence list), then the raw
Anthropic stream (`claude-sonnet-5`, adaptive thinking, `max_tokens 2048`, no sampling params),
then `done`. Both messages persist in the stream's `flush()` before the connection closes.

The system prompt has three blocks:
1. **Charter** (cached) — teach from the course, cite `[n]` only from provided evidence, and follow
   the help ladder: L0 diagnose → L1 hint → L2 one guided step → L3 worked analogy → L4 full
   explanation. Escalate only on shown attempt / explicit request / persistent stuck.
2. **Policy mode** (cached, per course, set in the instructor panel):
   `open` L4 freely · `guided` (default) ladder with L3 cap until an attempt is shown ·
   `practice` never reveal before the student commits an answer (L2 cap) · `review` L4 by default
   with full worked solutions.
3. **Turn state** (uncached) — current help level, whether an attempt was shown, requested help.

Evidence rides inside the user message in a `<course_evidence>` wrapper with explicit
untrusted-data framing (course files are data, not instructions — prompt-injection hygiene).
Daily metering: `polya_increment_usage`, 300 tutor turns/day, fail-open.

## Shared-project rules

See `CLAUDE.md` — MCP-only migration applies, additive-only, `polya_` namespace only, tokens and
provider keys never leave edge functions.

## Roadmap (explicitly out of v1)

OCR for scanned PDFs · Kaltura auto-fetch · extension-as-connector onboarding · shared cross-user
course index · per-assignment policies with timed solution release · mastery checks / learning
receipts · LTI 1.3 and institutional admin · Brightspace (endpoint map already exists in the
extension) · Vercel deploy + product domain.
