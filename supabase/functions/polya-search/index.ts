// polya-search — hybrid retrieval as JSON (no LLM). Used by the eval harness
// and the source panel's "related passages".
import { corsHeaders, json } from "../_shared/cors.ts";
import { HttpError, requireAuthUser, createUserClient } from "../_shared/auth-user.ts";
import { retrieve } from "../_shared/retrieval.ts";
import { buildSources } from "../_shared/prompts.ts";

interface SearchBody {
  course_id: string;
  query: string;
  exclude_roles?: string[];
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    await requireAuthUser(request);
    const body = (await request.json()) as SearchBody;
    if (!body.course_id || !body.query?.trim()) {
      return json({ error: "Missing course or query.", code: "bad_request" }, 400);
    }
    const userClient = createUserClient(request);
    const units = await retrieve(userClient, body.course_id, body.query, body.exclude_roles ?? []);
    return json({ results: buildSources(units) });
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message, code: "unauthorized" }, error.status);
    }
    console.error("[polya-search] error:", error);
    return json({ error: "Search failed.", code: "internal" }, 500);
  }
});
