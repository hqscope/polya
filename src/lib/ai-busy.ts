// AI-busy copy and classification (platform-hardening agent_plan R-5,
// COPY.md §11).
//
// Every paid-AI edge function (claude-proxy, gemini-proxy, polya-tutor,
// polya-search, polya-import, typesafe-decide) shares one project-wide daily
// budget per provider (`_shared/ai-budget.ts`, byte-identical in all three
// repos). Once a provider's budget is spent for the day it refuses with
// HTTP 503 and a JSON body `{ error, code: "busy" }`; `invokeFunction`
// (`@/lib/functions`) already surfaces that as `FunctionError.code`. It
// clears on its own at UTC midnight — never say why, never auto-retry, and
// never treat it as an error visually (no red, no warning icon).
//
// Pure and dependency-free so `tests/` can import it under Node's test
// runner with no network or Supabase client.

export const AI_BUSY_CODE = "busy";

/** True for any thrown value carrying `code: "busy"` (a `FunctionError`, a
 * parsed edge-function error body, or an SSE `error` payload). */
export function isAiBusy(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { code?: unknown }).code === AI_BUSY_CODE;
}

// `ai.busy.polya.tutor`: the reply slot, in place of an answer (not as the
// tutor speaking — no warning icon, no red).
export const AI_BUSY_POLYA_TUTOR =
  "Polya can't answer right now. Things are busier than usual, so try again in a little while. Your question is still in the box, and your lectures and notes are all here.";

// `ai.busy.polya.tutor.short`: same, for a one-line banner.
export const AI_BUSY_POLYA_TUTOR_SHORT = "Polya can't answer right now. Try again in a little while.";

// `ai.busy.polya.search`: inline under the search field. No client calls
// polya-search yet (grepped 2026-09-24 — no consumer in `src/`), so this is
// unused until a search UI is wired, the same way Lectra's typesafe-decide
// classification waits for a consumer.
export const AI_BUSY_POLYA_SEARCH =
  "Search is taking a break. Things are busier than usual, so try again in a little while.";

// `ai.busy.polya.search.hint`: under it, only if the surface has room.
export const AI_BUSY_POLYA_SEARCH_HINT = "Everything you've imported is still here.";

// `ai.busy.polya.import.status`: the source/course row, replacing the
// progress text while paused.
export const AI_BUSY_POLYA_IMPORT_STATUS = "Paused. Picks up again on its own.";

// `ai.busy.polya.import.detail`: under the status, or a detail sheet.
export const AI_BUSY_POLYA_IMPORT_DETAIL =
  "Things are busier than usual, so this import is waiting its turn. It continues on its own, and nothing you've already imported is affected. You can close Polya.";

// `ai.busy.polya.import.queue`: footer when more than one source is waiting.
export const AI_BUSY_POLYA_IMPORT_QUEUE =
  "Your other imports are waiting too. They all continue on their own.";

// `ai.busy.polya.import.resumed`: optional toast when a paused import starts
// moving again. Polya has no toast system today, so nothing shows this yet.
export const AI_BUSY_POLYA_IMPORT_RESUMED = "Import resumed.";
