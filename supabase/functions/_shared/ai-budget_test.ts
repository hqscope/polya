// This file is intentionally duplicated byte-for-byte in three repos:
//   - scope-platform/apps/extension/supabase/functions/_shared/ai-budget_test.ts
//   - lectra-ios/backend/functions/_shared/ai-budget_test.ts
//   - polya/supabase/functions/_shared/ai-budget_test.ts
// If you change this file, change all three.

import {
  AI_BUSY_MESSAGE,
  aiBusyResponse,
  claimAiBudget,
  estimateEmbeddingUnits,
  estimateModelUnits,
  estimateTokens,
  OCR_PAGE_UNITS,
  secondsUntilUtcReset,
  UNITS_PER_DOLLAR,
} from "./ai-budget.ts";
import type { RpcClient } from "./rate-limit.ts";

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

const USER = "00000000-0000-0000-0000-000000000001";

// Silence the helper's own console output for the refusal/error cases.
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { error, warn } = console;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

// --- claimAiBudget ---

Deno.test("claimAiBudget is ok when the RPC allows, and passes its arguments", async () => {
  const client = fakeClient(() => ({ data: "allow", error: null }));
  const result = await claimAiBudget(client, "anthropic", USER, 212.4);
  assert(result === "ok", "allow maps to ok");
  assert(client.calls.length === 1, "one rpc call");
  assert(client.calls[0].fn === "claim_ai_budget", "calls claim_ai_budget");
  assert(client.calls[0].args.p_provider === "anthropic", "passes provider");
  assert(client.calls[0].args.p_user_id === USER, "passes user id");
  assert(client.calls[0].args.p_units === 213, "rounds units up");
});

Deno.test("claimAiBudget passes a null user through", async () => {
  const client = fakeClient(() => ({ data: "allow", error: null }));
  assert((await claimAiBudget(client, "gemini", null, 1)) === "ok", "null user allowed");
  assert(client.calls[0].args.p_user_id === null, "null user id");
});

Deno.test("claimAiBudget is busy when the RPC denies", async () => {
  const client = fakeClient(() => ({ data: "deny", error: null }));
  assert((await quietly(() => claimAiBudget(client, "gemini", USER, 10))) === "busy", "deny maps to busy");
});

Deno.test("claimAiBudget fails closed on an RPC error", async () => {
  const client = fakeClient(() => ({ data: null, error: { message: "boom" } }));
  assert((await quietly(() => claimAiBudget(client, "anthropic", USER, 10))) === "unavailable", "error refuses");
});

Deno.test("claimAiBudget fails closed when the client throws", async () => {
  const client: RpcClient = {
    rpc() {
      throw new Error("network down");
    },
  };
  assert((await quietly(() => claimAiBudget(client, "anthropic", USER, 10))) === "unavailable", "throw refuses");
});

Deno.test("claimAiBudget fails closed on a rejected promise", async () => {
  const client: RpcClient = {
    rpc() {
      return Promise.reject(new Error("timeout"));
    },
  };
  assert((await quietly(() => claimAiBudget(client, "typesafe", USER, 10))) === "unavailable", "reject refuses");
});

Deno.test("claimAiBudget fails closed on anything but 'allow' or 'deny'", async () => {
  for (const data of [true, false, null, undefined, "ALLOW", 1, {}]) {
    const client = fakeClient(() => ({ data, error: null }));
    const result = await quietly(() => claimAiBudget(client, "gemini", USER, 1));
    assert(result === "unavailable", `unexpected ${JSON.stringify(data)} refuses`);
  }
});

Deno.test("claimAiBudget refuses invalid units without calling the RPC", async () => {
  for (const units of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const client = fakeClient(() => ({ data: "allow", error: null }));
    assert((await claimAiBudget(client, "gemini", USER, units)) === "unavailable", `units ${units} refused`);
    assert(client.calls.length === 0, "no rpc for invalid units");
  }
});

// --- estimates ---

Deno.test("estimateTokens over-counts at 3 characters per token", () => {
  assert(estimateTokens(0) === 0, "zero");
  assert(estimateTokens(-5) === 0, "negative");
  assert(estimateTokens(Number.NaN) === 0, "NaN");
  assert(estimateTokens(1) === 1, "rounds up");
  assert(estimateTokens(3_000) === 1_000, "3 chars per token");
});

Deno.test("estimateModelUnits charges input plus the full output allowance", () => {
  // Haiku: 3,000 chars = 1,000 tokens at $1/M = $0.001; 4,096 out at $5/M = $0.02048.
  // Total $0.02148 -> 214.8 units -> 215.
  assert(estimateModelUnits("claude-haiku-4-5", 3_000, 4_096) === 215, "haiku agent turn");
  // A full Course Brain corpus on Haiku: 900k chars = 300k tokens = $0.30, plus $0.02048.
  assert(estimateModelUnits("claude-haiku-4-5", 900_000, 4_096) === 3_205, "haiku full corpus");
  // gemini-2.5-flash syllabus parse: 15k chars = 5k tokens = $0.0015; 8,192 out = $0.02048.
  assert(estimateModelUnits("gemini-2.5-flash", 15_000, 8_192) === 220, "flash parse");
  // Sonnet 5 tutor ceiling: 42k chars = 14k tokens = $0.028; 2,048 out = $0.02048.
  assert(estimateModelUnits("claude-sonnet-5", 42_000, 2_048) === 485, "sonnet 5 turn");
});

Deno.test("estimateModelUnits is at least 1 and prices unknown models high", () => {
  assert(estimateModelUnits("gemini-2.5-flash-lite", 0, 0) === 1, "floor of 1");
  assert(estimateModelUnits("gemini-2.5-flash", 10, Number.NaN) === 1, "bad output treated as 0");
  const known = estimateModelUnits("claude-sonnet-4-6", 30_000, 1_000);
  const unknown = estimateModelUnits("some-future-model", 30_000, 1_000);
  assert(unknown > known, "unknown model costs more than Sonnet");
  assert(estimateModelUnits("toString", 30_000, 1_000) === unknown, "prototype keys aren't prices");
});

Deno.test("estimateEmbeddingUnits prices gemini-embedding-001 input only", () => {
  // 1,500 chars = 500 tokens at $0.15/M = $0.000075 -> 1 unit (the floor).
  assert(estimateEmbeddingUnits(1_500) === 1, "one query");
  // 2,000 chars = 667 tokens = $0.00010005 -> just over 1 unit -> 2.
  assert(estimateEmbeddingUnits(2_000) === 2, "rounds up, not down");
  // A typical course: ~2.1M chars = 700k tokens = $0.105 -> 1,050 units.
  assert(estimateEmbeddingUnits(2_100_000) === 1_050, "one course");
});

Deno.test("unit constants", () => {
  assert(UNITS_PER_DOLLAR === 10_000, "1 unit = $0.0001");
  assert(OCR_PAGE_UNITS === 20, "OCR page = $0.002");
});

// --- busy response ---

Deno.test("aiBusyResponse is a friendly 503 with CORS headers and Retry-After", async () => {
  const now = new Date(Date.UTC(2026, 8, 24, 23, 0, 0));
  const response = aiBusyResponse({ headers: { "Access-Control-Allow-Origin": "*" }, now });
  assert(response.status === 503, "503");
  assert(response.headers.get("Access-Control-Allow-Origin") === "*", "merges caller headers");
  assert(response.headers.get("Content-Type") === "application/json", "json");
  assert(response.headers.get("Retry-After") === "3600", "retry at the UTC reset");
  const body = await response.json();
  assert(body.error === AI_BUSY_MESSAGE, "friendly message");
  assert(body.code === "busy", "busy code");
  assert(!/budget|quota|server|token|supabase/i.test(AI_BUSY_MESSAGE), "no mechanics in the copy");
});

Deno.test("secondsUntilUtcReset counts down to UTC midnight", () => {
  assert(secondsUntilUtcReset(new Date(Date.UTC(2026, 8, 24, 0, 0, 0))) === 86_400, "start of day");
  assert(secondsUntilUtcReset(new Date(Date.UTC(2026, 8, 24, 23, 59, 59, 500))) === 1, "never below 1");
});
