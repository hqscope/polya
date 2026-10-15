// Course-material search for one linked student, run server-side with the service-role client.
// Mirrors Polya's own search; keep in step with:
//   - limits, budget, query cap:  polya/supabase/functions/polya-search/index.ts
//   - hybrid retrieval:           polya/supabase/functions/_shared/retrieval.ts (retrieve)
//   - query embedding request:    polya/supabase/functions/_shared/embeddings.ts (geminiBatch)
//   - course list:                polya/src/lib/mcp/data.ts (listCourses); mode via courses.ts
//
// Why not Polya's own path: polya-search needs the student's access token, and its two search
// functions (polya_match_units, polya_search_units_fts) select `where u.user_id = auth.uid()`.
// The service-role client has no auth.uid(), so they return nothing here. This file calls
// service-role-only twins that take the student id explicitly (polya_match_units_for_user,
// polya_search_units_fts_for_user; SQL proposed separately, not applied). Until those exist it
// falls back to full-text search over polya_content_units directly (no semantic ranking).
//
// The service role bypasses RLS, so every read below filters by the student's user_id, and the
// course is resolved only from that student's own courses before any search runs.
import type { SupabaseClient } from "@supabase/supabase-js";

import { getCourseMode } from "./courses.ts";
import {
  courseChoices,
  matchCourse,
  PASSAGES_MAX,
  polyaAppUrl,
  toSearchFound,
  type CourseChoice,
  type CourseRow,
  type SearchNotice,
  type SearchToolResult,
  type SourceMeta,
} from "./search-format.ts";
import {
  checkSearchQuery,
  EMBED_DIM,
  estimateEmbeddingUnits,
  FTS_CANDIDATES,
  fuseHits,
  isEmbedding,
  isMissingFunction,
  l2Normalize,
  lexicalQueries,
  parseUsageTotal,
  rankLexical,
  searchTerms,
  toVectorLiteral,
  VECTOR_CANDIDATES,
  withoutRoles,
  type RetrievedUnit,
} from "./search-rank.ts";
import { excludedRolesFor } from "./study-rules.ts";

// The same per-student windows as polya-search, so texting and the web app share one allowance.
const SEARCH_HOURLY_LIMIT = 120;
const SEARCH_HOURLY_BUCKET = "polya-search:hour";
const SEARCH_DAILY_LIMIT = 600; // polya-rate-limits.ts SEARCH_DAILY_LIMIT
const SEARCH_DAILY_BUCKET = "polya-search:day";

const MATCH_RPC = "polya_match_units_for_user";
const FTS_RPC = "polya_search_units_fts_for_user";

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents";
const GEMINI_TIMEOUT_MS = 8_000;

// Fallback candidate pools: every-term matches first, then any-term matches.
const FALLBACK_ALL_CANDIDATES = 12;
const FALLBACK_ANY_CANDIDATES = 40;

// retrieval.ts unitSelect(): the RetrievedUnit columns minus title and score.
const UNIT_COLUMNS =
  "unit_id:id, source_id, unit_type, content_role, ordinal, heading_path, page_start, page_end, t_start_ms, t_end_ms, procedure_id, step_number, content";

const SEARCH_FAILED = "Search failed. Try again in a moment.";

function rows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "unknown";
}

// Logs only the error code: no query text, ids or keys.
function failure(message: string, step: string, error: unknown): Error {
  console.error(`[search] ${step} failed (${errorCode(error)})`);
  return new Error(message);
}

function notice(status: SearchNotice["status"], message: string, courses: CourseChoice[] = []): SearchNotice {
  return { status, message, courses };
}

export async function searchCourseMaterials(
  db: SupabaseClient,
  studentId: string,
  courseInput: string,
  query: string,
  signal?: AbortSignal,
): Promise<SearchToolResult> {
  const appUrl = polyaAppUrl(process.env.POLYA_APP_URL);

  const queryCheck = checkSearchQuery(query);
  if (queryCheck === "too_long") {
    return notice("bad_query", "That search couldn't run. Keep the question under 2,000 characters.");
  }
  if (queryCheck === "missing") return notice("bad_query", "Say what to look for in the course.");

  const courses = await studentCourses(db, studentId);
  if (courses.length === 0) {
    return notice("no_courses", `The student hasn't added any courses to Polya yet. They can add one at ${appUrl}.`);
  }
  const pick = matchCourse(courses, courseInput);
  if (pick.kind === "ambiguous") {
    return notice(
      "pick_course",
      `More than one of the student's courses matches "${courseInput}". Ask which one they mean, then search again with that course.`,
      courseChoices(pick.candidates),
    );
  }
  if (pick.kind === "none") {
    return notice(
      "pick_course",
      `None of the student's courses matches "${courseInput}". Ask which one they mean, then search again with that course.`,
      courseChoices(courses),
    );
  }

  const course = pick.course;
  // Throws if the mode can't be read: never guess one that might allow answer keys.
  const mode = await getCourseMode(db, studentId, course.id);
  if (!(await withinSearchLimits(db, studentId))) {
    return notice("limited", "Polya's search limit for now has been reached. Try again later.");
  }

  const excludeRoles = excludedRolesFor(mode);
  const found = await retrieve(db, studentId, course.id, query.trim(), excludeRoles, signal);
  const units = withoutRoles(found, excludeRoles);
  return toSearchFound(course, mode, units, await sourceMeta(db, studentId, course.id, units), appUrl);
}

async function studentCourses(db: SupabaseClient, studentId: string): Promise<CourseRow[]> {
  const { data, error } = await db
    .from("polya_courses")
    .select("id, name, code, term_name, import_status")
    .eq("user_id", studentId)
    .order("created_at", { ascending: false });
  if (error) throw failure("Couldn't load the student's courses. Try again in a moment.", "courses", error);
  return rows<CourseRow>(data);
}

// polya-search's hourly window, then its daily cap. Both fail closed, as there.
async function withinSearchLimits(db: SupabaseClient, studentId: string): Promise<boolean> {
  try {
    const hourly = await db.rpc("claim_rate_limit", {
      p_subject: `user:${studentId}`,
      p_bucket: SEARCH_HOURLY_BUCKET,
      p_limit: SEARCH_HOURLY_LIMIT,
      p_window_seconds: 3_600,
    });
    if (hourly.error) console.error(`[search] hourly limit check failed (${errorCode(hourly.error)})`);
    if (hourly.error || hourly.data !== true) return false;

    const daily = await db.rpc("increment_usage_daily", {
      p_user_id: studentId,
      p_bucket: SEARCH_DAILY_BUCKET,
      p_units: 1,
    });
    if (daily.error) console.error(`[search] daily cap check failed (${errorCode(daily.error)})`);
    const total = daily.error ? null : parseUsageTotal(daily.data);
    return total !== null && total <= SEARCH_DAILY_LIMIT;
  } catch (error) {
    console.error(`[search] limit check failed (${errorCode(error)})`);
    return false;
  }
}

async function retrieve(
  db: SupabaseClient,
  studentId: string,
  courseId: string,
  query: string,
  excludeRoles: string[],
  signal: AbortSignal | undefined,
): Promise<RetrievedUnit[]> {
  const fts = await db.rpc(FTS_RPC, {
    p_user_id: studentId,
    p_course_id: courseId,
    p_query: query,
    p_limit: FTS_CANDIDATES,
    p_exclude_roles: excludeRoles,
  });
  if (isMissingFunction(fts.error)) {
    return lexicalFallback(db, studentId, courseId, query, excludeRoles);
  }
  if (fts.error) throw failure(SEARCH_FAILED, "full-text search", fts.error);

  // Semantic half. Any problem here (no key, budget spent, Gemini down) leaves the lexical half.
  let vectorHits: RetrievedUnit[] = [];
  const embedding = await queryEmbedding(db, studentId, query, signal);
  if (embedding) {
    const vector = await db.rpc(MATCH_RPC, {
      p_user_id: studentId,
      p_course_id: courseId,
      p_query_embedding: toVectorLiteral(embedding),
      p_limit: VECTOR_CANDIDATES,
      p_exclude_roles: excludeRoles,
    });
    if (vector.error) console.error(`[search] semantic search failed (${errorCode(vector.error)})`);
    else vectorHits = rows<RetrievedUnit>(vector.data);
  }

  return fuseHits(vectorHits, rows<RetrievedUnit>(fts.data), PASSAGES_MAX);
}

/** The query's Gemini embedding, or null to search without it. Claims the shared Gemini budget first. */
async function queryEmbedding(
  db: SupabaseClient,
  studentId: string,
  query: string,
  signal: AbortSignal | undefined,
): Promise<number[] | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const budget = await db.rpc("claim_ai_budget", {
    p_provider: "gemini",
    p_user_id: studentId,
    p_units: estimateEmbeddingUnits(query.length),
  });
  if (budget.error) console.error(`[search] Gemini budget check failed (${errorCode(budget.error)})`);
  if (budget.error || budget.data !== "allow") return null;

  const timeout = AbortSignal.timeout(GEMINI_TIMEOUT_MS);
  try {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      // Key in a header, not the URL, so it never lands in a logged URL.
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        requests: [
          {
            model: "models/gemini-embedding-001",
            content: { parts: [{ text: query }] },
            taskType: "RETRIEVAL_QUERY",
            outputDimensionality: EMBED_DIM,
          },
        ],
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      console.error(`[search] query embedding failed (HTTP ${response.status})`);
      return null;
    }
    const body = (await response.json()) as { embeddings?: Array<{ values?: unknown }> };
    const values = body.embeddings?.[0]?.values;
    return isEmbedding(values) ? l2Normalize(values) : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error(`[search] query embedding failed (${errorCode(error)})`);
    return null;
  }
}

/** Full-text search straight over the student's units, for when the *_for_user functions are missing. */
async function lexicalFallback(
  db: SupabaseClient,
  studentId: string,
  courseId: string,
  query: string,
  excludeRoles: string[],
): Promise<RetrievedUnit[]> {
  const terms = searchTerms(query);
  const queries = lexicalQueries(terms);
  if (!queries) return [];

  const run = (text: string, limit: number) => {
    let request = db
      .from("polya_content_units")
      .select(UNIT_COLUMNS)
      .eq("user_id", studentId)
      .eq("course_id", courseId)
      .textSearch("search_vector", text, { type: "websearch", config: "english" });
    if (excludeRoles.length > 0) request = request.not("content_role", "in", `(${excludeRoles.join(",")})`);
    return request.limit(limit);
  };

  const [all, any] = await Promise.all([
    run(queries.all, FALLBACK_ALL_CANDIDATES),
    terms.length > 1 ? run(queries.any, FALLBACK_ANY_CANDIDATES) : Promise.resolve(null),
  ]);
  if (all.error) throw failure(SEARCH_FAILED, "fallback search", all.error);
  if (any?.error) throw failure(SEARCH_FAILED, "fallback search", any.error);

  type UnitRow = Omit<RetrievedUnit, "title" | "score">;
  const byId = new Map<string, RetrievedUnit>();
  for (const row of [...rows<UnitRow>(all.data), ...rows<UnitRow>(any?.data)]) {
    if (!byId.has(row.unit_id)) byId.set(row.unit_id, { ...row, title: null, score: 0 });
  }
  return rankLexical(terms, Array.from(byId.values()), PASSAGES_MAX);
}

/** Titles and Canvas links for the passages' sources, read under the same student filter. */
async function sourceMeta(
  db: SupabaseClient,
  studentId: string,
  courseId: string,
  units: readonly RetrievedUnit[],
): Promise<Map<string, SourceMeta>> {
  const ids = Array.from(new Set(units.map((unit) => unit.source_id)));
  if (ids.length === 0) return new Map();
  const { data, error } = await db
    .from("polya_sources")
    .select("id, title, canvas_url")
    .eq("user_id", studentId)
    .eq("course_id", courseId)
    .in("id", ids);
  if (error) {
    // Passages still carry titles from the search rows; only links are lost.
    console.error(`[search] source details failed (${errorCode(error)})`);
    return new Map();
  }
  return new Map(
    rows<{ id: string; title: string; canvas_url: string | null }>(data).map((row) => [
      row.id,
      { title: row.title, canvas_url: row.canvas_url },
    ]),
  );
}
