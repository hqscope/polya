// This file is intentionally duplicated byte-for-byte in three repos:
//   - scope-platform/apps/extension/supabase/functions/_shared/rate-limit_test.ts
//   - lectra-ios/backend/functions/_shared/rate-limit_test.ts
//   - polya/supabase/functions/_shared/rate-limit_test.ts
// If you change this file, change all three.

import {
  claimRateLimit,
  incrementUsageDaily,
  rateLimitedResponse,
  RpcClient,
  withinDailyCap,
} from "./rate-limit.ts";

function assert(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
}

type RpcResult = { data: unknown; error: unknown };

function fakeClient(
  handler: (fn: string, args: Record<string, unknown>) => RpcResult | Promise<RpcResult>,
): RpcClient & { calls: Array<{ fn: string; args: Record<string, unknown> }> } {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve(handler(fn, args));
    },
  };
}

// --- claimRateLimit ---

Deno.test("claimRateLimit allows when the RPC returns true", async () => {
  const client = fakeClient(() => ({ data: true, error: null }));
  assert(await claimRateLimit(client, "user:abc", "gemini:hour", 10, 3600), "should allow");
  assert(client.calls.length === 1, "one rpc call");
  assert(client.calls[0].fn === "claim_rate_limit", "calls claim_rate_limit");
  assert(client.calls[0].args.p_subject === "user:abc", "passes subject");
  assert(client.calls[0].args.p_bucket === "gemini:hour", "passes bucket");
  assert(client.calls[0].args.p_limit === 10, "passes limit");
  assert(client.calls[0].args.p_window_seconds === 3600, "passes window");
});

Deno.test("claimRateLimit denies when the RPC returns false", async () => {
  const client = fakeClient(() => ({ data: false, error: null }));
  assert(!(await claimRateLimit(client, "user:abc", "gemini:hour", 10, 3600)), "should deny");
});

Deno.test("claimRateLimit denies on an RPC error", async () => {
  const client = fakeClient(() => ({ data: null, error: { message: "boom" } }));
  assert(!(await claimRateLimit(client, "anon:xyz", "gemini:hour", 10, 3600)), "error denies");
});

Deno.test("claimRateLimit denies when the client throws", async () => {
  const client: RpcClient = {
    rpc() {
      throw new Error("network down");
    },
  };
  assert(!(await claimRateLimit(client, "ip:1.2.3.4", "gemini:hour", 10, 3600)), "thrown denies");
});

Deno.test("claimRateLimit denies on a non-true, non-false result", async () => {
  const client = fakeClient(() => ({ data: "true", error: null }));
  assert(!(await claimRateLimit(client, "user:abc", "gemini:hour", 10, 3600)), "only literal true allows");
});

// --- incrementUsageDaily ---

Deno.test("incrementUsageDaily returns the new total", async () => {
  const client = fakeClient(() => ({ data: 7, error: null }));
  const total = await incrementUsageDaily(client, "00000000-0000-0000-0000-000000000000", "gemini:day");
  assert(total === 7, "returns the numeric total");
  assert(client.calls[0].fn === "increment_usage_daily", "calls increment_usage_daily");
  assert(client.calls[0].args.p_units === 1, "defaults units to 1");
});

Deno.test("incrementUsageDaily accepts a custom units value and a bigint result", async () => {
  const client = fakeClient((_fn, args) => ({ data: BigInt(args.p_units as number) + 5n, error: null }));
  const total = await incrementUsageDaily(client, "u", "gemini:day", 3);
  assert(total === 8, "bigint result is coerced to number");
  assert(client.calls[0].args.p_units === 3, "passes custom units");
});

Deno.test("incrementUsageDaily returns null on an RPC error", async () => {
  const client = fakeClient(() => ({ data: null, error: { message: "bad input" } }));
  assert((await incrementUsageDaily(client, "u", "gemini:day")) === null, "error is null");
});

Deno.test("incrementUsageDaily returns null when the client throws", async () => {
  const client: RpcClient = {
    rpc() {
      return Promise.reject(new Error("bad input"));
    },
  };
  assert((await incrementUsageDaily(client, "u", "gemini:day")) === null, "thrown is null");
});

// --- withinDailyCap ---

Deno.test("withinDailyCap allows when the new total is at or under the cap", async () => {
  const client = fakeClient(() => ({ data: 5, error: null }));
  assert(await withinDailyCap(client, "u", "gemini:day", 5), "at the cap allows");
});

Deno.test("withinDailyCap denies when the new total exceeds the cap", async () => {
  const client = fakeClient(() => ({ data: 6, error: null }));
  assert(!(await withinDailyCap(client, "u", "gemini:day", 5)), "over the cap denies");
});

Deno.test("withinDailyCap denies on a null total", async () => {
  const client = fakeClient(() => ({ data: null, error: { message: "boom" } }));
  assert(!(await withinDailyCap(client, "u", "gemini:day", 5)), "null total denies");
});

Deno.test("withinDailyCap still increments before checking (units passed through)", async () => {
  const client = fakeClient((_fn, args) => ({ data: args.p_units, error: null }));
  assert(await withinDailyCap(client, "u", "gemini:day", 10, 10), "10 units, cap 10, allows");
  assert(client.calls[0].args.p_units === 10, "units forwarded");
});

// --- rateLimitedResponse ---

Deno.test("rateLimitedResponse defaults to a friendly 429 with no mechanics", async () => {
  const response = rateLimitedResponse();
  assert(response.status === 429, "status is 429");
  const body = await response.json();
  assert(body.code === "rate_limited", "code is rate_limited");
  assert(body.error === "You've hit today's limit. Try again later.", "default message");
  assert(!response.headers.has("Retry-After"), "no Retry-After by default");
});

Deno.test("rateLimitedResponse uses a custom message and sets Retry-After", async () => {
  const response = rateLimitedResponse({ message: "Slow down.", retryAfterSeconds: 30 });
  const body = await response.json();
  assert(body.error === "Slow down.", "custom message used");
  assert(body.code === "rate_limited", "code stays rate_limited");
  assert(response.headers.get("Retry-After") === "30", "Retry-After set");
});

Deno.test("rateLimitedResponse merges in caller headers, e.g. CORS", async () => {
  const response = rateLimitedResponse({
    headers: { "Access-Control-Allow-Origin": "*", "X-Extra": "1" },
  });
  assert(response.headers.get("Access-Control-Allow-Origin") === "*", "CORS header merged");
  assert(response.headers.get("X-Extra") === "1", "arbitrary header merged");
  assert(response.headers.get("Content-Type") === "application/json", "content-type still set");
});

// This deliberately stays local: it models the single-row atomic upsert in
// 20260924022256_shared_rate_limit.sql without sending load to the shared
// project. The serialized critical section is the fake equivalent of the
// row lock PostgreSQL takes for INSERT ... ON CONFLICT DO UPDATE.
Deno.test("claimRateLimit concurrency contract admits exactly the configured limit", async () => {
  let count = 0;
  let tail = Promise.resolve();
  const limit = 25;
  const client: RpcClient = {
    rpc(_fn, args) {
      const result = tail.then(async () => {
        await Promise.resolve();
        count += 1;
        return { data: count <= Number(args.p_limit), error: null };
      });
      tail = result.then(() => undefined);
      return result;
    },
  };

  const results = await Promise.all(
    Array.from({ length: 100 }, () => claimRateLimit(client, "user:concurrent", "test:min", limit, 60)),
  );
  assert(results.filter(Boolean).length === limit, "exactly the first limit claims should pass");
  assert(results.filter((allowed) => !allowed).length === 75, "all excess concurrent claims should fail");
});
