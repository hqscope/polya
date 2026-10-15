// Pure retrieval pieces for course-material search. No Supabase or network imports, so Node's
// test runner covers this file directly. Copied from Polya; keep each block in step with its
// source when the original changes:
//   - RetrievedUnit:                 polya/supabase/functions/_shared/retrieval-types.ts
//   - rrfMerge / RRF_K:              polya/supabase/functions/_shared/rrf.ts
//   - roleWeight / dedupeBySignature polya/supabase/functions/_shared/rank.ts
//   - fuseHits constants and order:  polya/supabase/functions/_shared/retrieval.ts (retrieve)
//   - l2Normalize / toVectorLiteral: polya/supabase/functions/_shared/embeddings.ts
//   - estimateEmbeddingUnits:        polya/supabase/functions/_shared/ai-budget.ts
//   - parseUsageTotal:               polya/supabase/functions/_shared/rate-limit.ts (incrementUsageDaily)
//   - checkSearchQuery:              polya/supabase/functions/_shared/search-limits.ts
// The lexical fallback (searchTerms, lexicalQueries, rankLexical) is new here: it stands in for
// Polya's ts_rank ordering when the service-role search functions aren't in the database yet.

export interface RetrievedUnit {
  unit_id: string;
  source_id: string;
  unit_type: string;
  content_role: string;
  ordinal: number;
  heading_path: string | null;
  page_start: number | null;
  page_end: number | null;
  t_start_ms: number | null;
  t_end_ms: number | null;
  procedure_id: string | null;
  step_number: number | null;
  title: string | null;
  content: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Query limits (search-limits.ts)
// ---------------------------------------------------------------------------
export const SEARCH_QUERY_MAX_CHARS = 2_000;

export type SearchQueryCheck = "ok" | "missing" | "too_long";

export function checkSearchQuery(query: unknown): SearchQueryCheck {
  if (typeof query !== "string") return "missing";
  const trimmed = query.trim();
  if (!trimmed) return "missing";
  return trimmed.length > SEARCH_QUERY_MAX_CHARS ? "too_long" : "ok";
}

// ---------------------------------------------------------------------------
// Fusion (rrf.ts, rank.ts, retrieval.ts)
// ---------------------------------------------------------------------------
export const RRF_K = 60;
export const VECTOR_CANDIDATES = 12;
export const FTS_CANDIDATES = 12;
export const MIN_VECTOR_SIMILARITY = 0.25; // vector-only hits below this are dropped

export function rrfMerge<T>(
  listA: readonly T[],
  listB: readonly T[],
  idExtractor: (item: T) => string,
  k: number = RRF_K,
  weightOf?: (item: T) => number,
): T[] {
  const scores = new Map<string, number>();
  const itemMap = new Map<string, T>();

  const processList = (list: readonly T[]) => {
    list.forEach((item, index) => {
      const id = idExtractor(item);
      const weight = weightOf ? weightOf(item) : 1;
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + index + 1));
      itemMap.set(id, item);
    });
  };

  processList(listA);
  processList(listB);

  return Array.from(scores.keys())
    .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
    .map((id) => itemMap.get(id) as T);
}

// Mild role weighting: tips otherwise-comparable matches toward teaching material.
const ROLE_WEIGHT: Record<string, number> = {
  material: 1.0,
  syllabus: 0.85,
  assignment: 0.8,
  solution_key: 0.8,
};

export function roleWeight(role: string): number {
  return ROLE_WEIGHT[role] ?? 1.0;
}

// Case/punctuation/whitespace-insensitive first 160 chars, to spot near-identical chunks.
export function contentSignature(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** Keeps the first (best-ranked) of near-identical chunks, e.g. repeated "submit this quiz" blurbs. */
export function dedupeBySignature<T extends { content: string }>(hits: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const hit of hits) {
    const signature = contentSignature(hit.content);
    if (signature && seen.has(signature)) continue;
    if (signature) seen.add(signature);
    out.push(hit);
  }
  return out;
}

/**
 * retrieve()'s fusion step: drop weak vector-only hits unless they also matched lexically, fuse
 * with role-weighted RRF, drop near-duplicates, keep the top `limit`. Polya then expands hits
 * with neighbor chunks and procedure steps; this agent skips that to stay text-message sized.
 */
export function fuseHits(
  vectorHits: readonly RetrievedUnit[],
  ftsHits: readonly RetrievedUnit[],
  limit: number,
): RetrievedUnit[] {
  const ftsIds = new Set(ftsHits.map((hit) => hit.unit_id));
  const vectorFiltered = vectorHits.filter(
    (hit) => hit.score >= MIN_VECTOR_SIMILARITY || ftsIds.has(hit.unit_id),
  );
  const fused = rrfMerge(vectorFiltered, ftsHits, (hit) => hit.unit_id, RRF_K, (hit) =>
    roleWeight(hit.content_role),
  );
  return dedupeBySignature(fused).slice(0, limit);
}

/** Belt and braces over the database filter: never pass a withheld role through. */
export function withoutRoles<T extends { content_role: string }>(units: T[], roles: readonly string[]): T[] {
  if (roles.length === 0) return units;
  const excluded = new Set(roles);
  return units.filter((unit) => !excluded.has(unit.content_role));
}

// ---------------------------------------------------------------------------
// Query embedding helpers (embeddings.ts, ai-budget.ts)
// ---------------------------------------------------------------------------
export const EMBED_DIM = 1536;

/** gemini-embedding-001 at 1536 dims isn't pre-normalized; cosine ranking needs unit vectors. */
export function l2Normalize(vector: number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

/** A Gemini reply's vector, checked before it reaches the database. */
export function isEmbedding(values: unknown): values is number[] {
  return (
    Array.isArray(values) &&
    values.length === EMBED_DIM &&
    values.every((value) => typeof value === "number" && Number.isFinite(value))
  );
}

/** pgvector text literal: '[0.1,0.2,...]'. */
export function toVectorLiteral(values: readonly number[]): string {
  return `[${values.join(",")}]`;
}

// claim_ai_budget units: 1 unit = $0.0001. Inputs are taken as chars / 3 tokens (deliberately
// high), priced at gemini-embedding-001's $0.15 per million input tokens. Never less than 1.
export function estimateEmbeddingUnits(totalChars: number): number {
  const tokens = Number.isFinite(totalChars) && totalChars > 0 ? Math.ceil(totalChars / 3) : 0;
  const dollars = (tokens * 0.15) / 1_000_000;
  const units = Math.round(dollars * 10_000 * 1_000_000) / 1_000_000;
  return Math.max(1, Math.ceil(units));
}

// ---------------------------------------------------------------------------
// Lexical fallback (new): used only when the service-role search functions are missing.
// ---------------------------------------------------------------------------
const STOPWORDS = new Set(
  (
    "the and not for are but was were what when where which who whom why how does did doing done " +
    "this that these those with from into onto about than then there their they them you your " +
    "its can could should would will shall may might must have has had our out any all some " +
    "just like also very more most much many such only own same too get got use using used " +
    "help explain tell show need want know mean means find give make please"
  ).split(" "),
);

const MAX_TERMS = 12;

/** Distinct lowercase content words (3+ chars, no stopwords), in query order. */
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const out: string[] = [];
  for (const word of words) {
    if (word.length < 3 || STOPWORDS.has(word) || out.includes(word)) continue;
    out.push(word);
    if (out.length === MAX_TERMS) break;
  }
  return out;
}

/**
 * websearch_to_tsquery inputs over the sanitized terms: `all` matches every term (what Polya's
 * own full-text search does with the raw query), `any` matches at least one. Terms are bare
 * [a-z0-9] words, so no quote, dash or "or" in the student's text can act as an operator.
 */
export function lexicalQueries(terms: readonly string[]): { all: string; any: string } | null {
  if (terms.length === 0) return null;
  return { all: terms.join(" "), any: terms.join(" or ") };
}

// Crude stem so "eigenvalues" credits "eigenvalue" (Postgres already matched with real stemming;
// this only orders the rows it returned).
function stem(term: string): string {
  return term.length > 5 ? term.slice(0, term.length - 2) : term;
}

/** Orders full-text matches by how many distinct terms each one covers, heading hits a little higher. */
export function rankLexical(
  terms: readonly string[],
  units: readonly RetrievedUnit[],
  limit: number,
): RetrievedUnit[] {
  const stems = terms.map(stem);
  const scored = units.map((unit, index) => {
    const body = unit.content.toLowerCase();
    const heading = (unit.heading_path ?? "").toLowerCase();
    let score = 0;
    for (const s of stems) {
      if (body.includes(s)) score += 1;
      if (heading.includes(s)) score += 0.5;
    }
    return { unit: { ...unit, score: score * roleWeight(unit.content_role) }, index };
  });
  scored.sort((a, b) => b.unit.score - a.unit.score || a.index - b.index);
  return dedupeBySignature(scored.map((entry) => entry.unit)).slice(0, limit);
}

/**
 * increment_usage_daily's new total (rate-limit.ts incrementUsageDaily): a number, bigint or
 * numeric string. Anything else is null, which callers treat as over the cap (fail closed).
 */
export function parseUsageTotal(data: unknown): number | null {
  if (typeof data === "number") return Number.isFinite(data) ? data : null;
  if (typeof data === "bigint") return Number(data);
  if (typeof data === "string" && data.trim() !== "" && !Number.isNaN(Number(data))) return Number(data);
  return null;
}

/** PostgREST's "function not found" (PGRST202) or Postgres's undefined_function (42883). */
export function isMissingFunction(error: { code?: string } | null | undefined): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}
