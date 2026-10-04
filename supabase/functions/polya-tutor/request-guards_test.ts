// Phase 9 A-17: polya-tutor is POST-only and has an hourly per-user window
// that fails closed, exercised through the real handler against a fake
// backend (_shared/test-serve.ts).
//
// Run: deno test --allow-env --allow-read --no-check supabase/functions/polya-tutor/
import { assertEquals } from "jsr:@std/assert@1";
import {
  authRoute,
  jsonResponse,
  loadHandler,
  rpcName,
  setBackend,
  TEST_USER_ID,
  TEST_USER_JWT,
} from "../_shared/test-serve.ts";
import { TUTOR_HOURLY_BUCKET, TUTOR_HOURLY_LIMIT } from "../_shared/polya-rate-limits.ts";

const handler = await loadHandler(new URL("./index.ts", import.meta.url).href);
const URL_ = "http://polya.test/functions/v1/polya-tutor";
const COURSE_ID = "00000000-0000-4000-8000-0000000000c1";

type Call = { name: string; args?: Record<string, unknown> };

// Answers auth for TEST_USER_JWT, every RPC with `rpc(name)`, and the course
// ownership lookup with "not yours" (an empty result). Returns the call log.
function backend(rpc: (name: string) => Response): Call[] {
  const calls: Call[] = [];
  setBackend(async (url, request) => {
    const auth = authRoute(url, request);
    if (auth) return auth;
    const name = rpcName(url);
    if (name) {
      calls.push({ name, args: (await request.json()) as Record<string, unknown> });
      return rpc(name);
    }
    if (url.pathname === "/rest/v1/polya_courses") {
      calls.push({ name: "select polya_courses" });
      return jsonResponse([]);
    }
    return null;
  });
  return calls;
}

function turn(): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_USER_JWT}` },
    body: JSON.stringify({ course_id: COURSE_ID, message: "Can you explain a hint for problem 2?" }),
  });
}

Deno.test("non-POST methods get 405 before any auth work; OPTIONS answers the preflight", async () => {
  const calls = backend(() => jsonResponse(true));
  for (const method of ["GET", "PUT", "DELETE"]) {
    const response = await handler(new Request(URL_, { method }));
    assertEquals(response.status, 405, method);
    assertEquals((await response.json()).code, "method_not_allowed");
  }
  const preflight = await handler(new Request(URL_, { method: "OPTIONS" }));
  assertEquals(preflight.status, 200);
  await preflight.body?.cancel();
  assertEquals(calls.length, 0);
});

Deno.test("the hourly window refuses when the limiter errors, says no or returns nothing", async () => {
  for (const answer of [
    () => jsonResponse({ message: "boom" }, 500),
    () => jsonResponse(false),
    () => jsonResponse(null),
  ]) {
    const calls = backend((name) => (name === "claim_rate_limit" ? answer() : jsonResponse(null)));
    const response = await handler(turn());
    assertEquals(response.status, 429);
    assertEquals((await response.json()).code, "rate_limited");
    assertEquals(calls.map((call) => call.name), ["claim_rate_limit"], "no ownership, meter or model work");
  }
});

Deno.test("the window is claimed per user in the tutor's hourly bucket", async () => {
  const calls = backend(() => jsonResponse(false));
  const response = await handler(turn());
  await response.body?.cancel();
  assertEquals(calls[0].args, {
    p_subject: `user:${TEST_USER_ID}`,
    p_bucket: TUTOR_HOURLY_BUCKET,
    p_limit: TUTOR_HOURLY_LIMIT,
    p_window_seconds: 3600,
  });
  assertEquals(TUTOR_HOURLY_LIMIT, 40);
});

Deno.test("an allowed claim moves on to the ownership check", async () => {
  const calls = backend(() => jsonResponse(true));
  const response = await handler(turn());
  assertEquals(response.status, 404, "the fake backend says the course isn't the caller's");
  await response.body?.cancel();
  assertEquals(calls.map((call) => call.name), ["claim_rate_limit", "select polya_courses"]);
});

Deno.test("no session is still a 401, before the limiter", async () => {
  const calls = backend(() => jsonResponse(true));
  const response = await handler(
    new Request(URL_, { method: "POST", body: JSON.stringify({ course_id: COURSE_ID, message: "hi" }) }),
  );
  assertEquals(response.status, 401);
  await response.body?.cancel();
  assertEquals(calls.length, 0);
});
