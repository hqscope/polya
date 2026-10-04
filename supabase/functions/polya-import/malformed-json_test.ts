// Documents review item R-21 (plans/platform-hardening/agent_plan.md, task
// 2.13 / Early review, fixed under R-21): a malformed JSON request body used
// to be parsed at index.ts:223 (`const body = (await request.json()) as
// Body;`) inside the same try block as the rest of the handler, BEFORE
// `requireAuthUser` runs, so an unauthenticated caller could trigger it. A
// `SyntaxError` from `request.json()` wasn't special-cased in the catch block
// and fell into the generic branch, coming back as
// `500 {"error":"Something went wrong importing your course.","code":"internal"}`
// instead of a `400` parse error. First noted under Task 2.6 ("left for
// 2.13's input-validation sweep") and confirmed still present by 2.13-Sol's
// source sweep.
//
// Fixed (R-21): the body is now parsed in its own try/catch before the
// dispatch try, returning `400 {"error":"Invalid request body.","code":
// "bad_request"}` on a parse failure — the same shape as every other
// `bad_request` in this file. This test now pins the FIXED behavior.
//
// Why this can be a real end-to-end request rather than a source-reading
// check: the parse fails before any Supabase call is made, so no live
// database or real service-role key is needed.
//
// Phase 9 A-9: the handler is now loaded in-process through
// `_shared/test-serve.ts` (Deno.serve captured, no port bound) so this file
// and `request-guards_test.ts` can share one import of index.ts.
import { assertEquals } from "jsr:@std/assert@1";
import { loadHandler, setBackend } from "../_shared/test-serve.ts";

const handler = await loadHandler(new URL("./index.ts", import.meta.url).href);

Deno.test({
  name: "polya-import: malformed JSON body — R-21 fixed (returns 400)",
  async fn() {
    setBackend(() => null); // any outbound call would throw and fail the test
    const response = await handler(
      new Request("http://polya.test/functions/v1/polya-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not valid json",
      }),
    );
    const body = await response.json();

    assertEquals(response.status, 400, "R-21: malformed JSON now returns 400");
    assertEquals(body.code, "bad_request", "R-21: parse failure returns bad_request");
  },
});
