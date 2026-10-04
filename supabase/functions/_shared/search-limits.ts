// Input limits for polya-search. Pure module (no Deno globals) so Node's test
// runner covers it directly.
//
// R-11 (early review, 2026-09-24): polya-search had no query-length cap.
// Each call pays for a Gemini embedding (retrieval.ts's embedQuery) on the
// GEMINI_API_KEY Polya and the extension share, so an unbounded query is a
// direct, unmetered cost lever.
export const SEARCH_QUERY_MAX_CHARS = 2_000;

export type SearchQueryCheck = "ok" | "missing" | "too_long";

export function checkSearchQuery(query: unknown): SearchQueryCheck {
  if (typeof query !== "string") return "missing";
  const trimmed = query.trim();
  if (!trimmed) return "missing";
  return trimmed.length > SEARCH_QUERY_MAX_CHARS ? "too_long" : "ok";
}
