// polya-search — hybrid retrieval as JSON (no LLM). Used by the eval harness
// and the source panel's "related passages".
//
// R-11 (early review, 2026-09-24): this had no rate limit, no query-length
// cap and no method check. Each call pays for a Gemini embedding
// (retrieval.ts's embedQuery) on the GEMINI_API_KEY Polya and the extension
// share. Added: the Task 2.2 shared limiter (120/hr per user, fail-closed),
// a 2,000-char query cap, and a POST-only check. verify_jwt stays true.
// Phase 9 A-17 added a daily window (600/day per user) over the hourly one.
import { corsHeaders, json } from "../_shared/cors.ts";
import { HttpError, requireAuthUser, createUserClient } from "../_shared/auth-user.ts";
import { retrieve } from "../_shared/retrieval.ts";
import { buildSources } from "../_shared/prompts.ts";
import { service } from "../_shared/service.ts";
import { claimRateLimit, rateLimitedResponse, withinDailyCap } from "../_shared/rate-limit.ts";
import { SEARCH_DAILY_BUCKET, SEARCH_DAILY_LIMIT } from "../_shared/polya-rate-limits.ts";
import { aiBusyResponse, claimAiBudget, estimateEmbeddingUnits } from "../_shared/ai-budget.ts";
import { checkSearchQuery, SEARCH_QUERY_MAX_CHARS } from "../_shared/search-limits.ts";

interface SearchBody {
  course_id: string;
  query: string;
  exclude_roles?: string[];
}

// Starting value, not yet in appendix B.2: mirrors typesafe-decide's per-hour
// cap, since both are metered, per-user retrieval-shaped calls. Tune after a
// week of logs.
const RATE_LIMIT_PER_HOUR = 120;

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed.", code: "method_not_allowed" }, 405);
  }
  try {
    const user = await requireAuthUser(request);
    const body = (await request.json().catch(() => ({}))) as Partial<SearchBody>;

    const queryCheck = checkSearchQuery(body.query);
    if (!body.course_id || queryCheck === "missing") {
      return json({ error: "Missing course or query.", code: "bad_request" }, 400);
    }
    if (queryCheck === "too_long") {
      return json(
        { error: `Query is too long (max ${SEARCH_QUERY_MAX_CHARS} characters).`, code: "bad_request" },
        400,
      );
    }

    const withinLimit = await claimRateLimit(
      service,
      `user:${user.id}`,
      "polya-search:hour",
      RATE_LIMIT_PER_HOUR,
      3600,
    );
    if (!withinLimit) {
      return rateLimitedResponse({ headers: corsHeaders });
    }

    // A-17: the daily window over the hourly one (increment_usage_daily).
    // Fails closed: a metering error refuses the search like an overage.
    if (!(await withinDailyCap(service, user.id, SEARCH_DAILY_BUCKET, SEARCH_DAILY_LIMIT))) {
      return rateLimitedResponse({ headers: corsHeaders });
    }

    // Project-wide daily Gemini budget (R-5) for the query embedding. Fails
    // closed: over budget or a metering error both get the busy 503.
    const budget = await claimAiBudget(
      service,
      "gemini",
      user.id,
      estimateEmbeddingUnits((body.query as string).length),
    );
    if (budget !== "ok") {
      return aiBusyResponse({ headers: corsHeaders });
    }

    const userClient = createUserClient(request);
    const units = await retrieve(userClient, body.course_id, body.query as string, body.exclude_roles ?? []);
    return json({ results: buildSources(units) });
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message, code: "unauthorized" }, error.status);
    }
    console.error("[polya-search] error:", error);
    return json({ error: "Search failed.", code: "internal" }, 500);
  }
});
