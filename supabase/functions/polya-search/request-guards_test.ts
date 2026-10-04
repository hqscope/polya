// Phase 9 A-17: polya-search's daily window (over the existing hourly one),
// failing closed, exercised through the real handler against a fake backend
// (_shared/test-serve.ts).
//
// Run: deno test --allow-env --allow-read --no-check supabase/functions/polya-search/
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
import { SEARCH_DAILY_BUCKET, SEARCH_DAILY_LIMIT } from "../_shared/polya-rate-limits.ts";

const handler = await loadHandler(new URL("./index.ts", import.meta.url).href);
const URL_ = "http://polya.test/functions/v1/polya-search";

type RpcCall = { name: string; args: Record<string, unknown> };

// Answers auth for TEST_USER_JWT and every RPC through `answers[name]`
// (anything unlisted is an error). The AI budget always answers with an error,
// so a search that gets past both windows stops there with the busy 503.
function backend(answers: Record<string, () => Response>): RpcCall[] {
  const calls: RpcCall[] = [];
  setBackend(async (url, request) => {
    const auth = authRoute(url, request);
    if (auth) return auth;
    const name = rpcName(url);
    if (!name) return null;
    calls.push({ name, args: (await request.json()) as Record<string, unknown> });
    return (answers[name] ?? (() => jsonResponse({ message: "no" }, 500)))();
  });
  return calls;
}

function search(): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_USER_JWT}` },
    body: JSON.stringify({ course_id: "00000000-0000-4000-8000-0000000000c1", query: "binomial" }),
  });
}

Deno.test("GET is still a 405", async () => {
  const response = await handler(new Request(URL_, { method: "GET" }));
  assertEquals(response.status, 405);
  await response.body?.cancel();
});

Deno.test("an hourly refusal never touches the daily counter", async () => {
  const calls = backend({ claim_rate_limit: () => jsonResponse(false) });
  const response = await handler(search());
  assertEquals(response.status, 429);
  await response.body?.cancel();
  assertEquals(calls.map((call) => call.name), ["claim_rate_limit"]);
});

Deno.test("the daily window fails closed when the counter errors or returns nothing", async () => {
  for (const answer of [() => jsonResponse({ message: "boom" }, 500), () => jsonResponse(null)]) {
    const calls = backend({ claim_rate_limit: () => jsonResponse(true), increment_usage_daily: answer });
    const response = await handler(search());
    assertEquals(response.status, 429);
    assertEquals((await response.json()).code, "rate_limited");
    assertEquals(calls.map((call) => call.name), ["claim_rate_limit", "increment_usage_daily"]);
  }
});

Deno.test("the daily window refuses one over the cap and allows the cap itself", async () => {
  const over = backend({
    claim_rate_limit: () => jsonResponse(true),
    increment_usage_daily: () => jsonResponse(SEARCH_DAILY_LIMIT + 1),
  });
  const refused = await handler(search());
  assertEquals(refused.status, 429);
  await refused.body?.cancel();
  assertEquals(over[1].args, { p_user_id: TEST_USER_ID, p_bucket: SEARCH_DAILY_BUCKET, p_units: 1 });

  const at = backend({
    claim_rate_limit: () => jsonResponse(true),
    increment_usage_daily: () => jsonResponse(SEARCH_DAILY_LIMIT),
  });
  const allowed = await handler(search());
  assertEquals(allowed.status, 503, "past both windows; the fake AI budget says busy");
  await allowed.body?.cancel();
  assertEquals(at.map((call) => call.name), ["claim_rate_limit", "increment_usage_daily", "claim_ai_budget"]);
  assertEquals(SEARCH_DAILY_LIMIT, 600);
});
