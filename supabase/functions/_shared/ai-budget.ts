// This file is intentionally duplicated byte-for-byte in three repos:
//   - scope-platform/apps/extension/supabase/functions/_shared/ai-budget.ts
//   - lectra-ios/backend/functions/_shared/ai-budget.ts
//   - polya/supabase/functions/_shared/ai-budget.ts
// It imports only rate-limit.ts (also identical in all three) so the copies
// can stay identical. If you change it, change all three and re-run
// ai-budget_test.ts (duplicated the same way) in each.
//
// Project-wide AI spend circuit breaker (early review R-5, 2026-09-24).
// Per-user limits (rate-limit.ts) bound one account, but sign-up is open, so
// many accounts x per-user caps is still unbounded. Every paid-AI function
// also claims from one daily budget per provider, counted in estimated cost
// units, through `claim_ai_budget(provider, user_id, units)` from
// lectra-ios/backend/migrations/*_ai_budget_breaker.sql:
//   1 unit = $0.0001, so 10,000 units = $1.
// Budgets live in public.ai_budget_config and change without a deploy.
// Accounts in public.ai_budget_allowlist are never refused, and their usage is
// counted separately so it can't trip the breaker for everyone else.
//
// Estimates are deliberately high: input tokens are taken as chars / 3, output
// as the whole max_tokens a call asked for, and prompt caching gets no credit.
// So the counter is roughly the most today's calls could have cost. OCR pages
// are the one exception (a typical-plus flat rate; see OCR_PAGE_UNITS).
//
// Call it after the per-user limits and input caps, right before the provider
// call. Any RPC error is a refusal ("unavailable"), like the rest of Phase 2.

import type { RpcClient } from "./rate-limit.ts";

export type AiProvider = "anthropic" | "gemini" | "typesafe";

/** "busy" = over today's budget; "unavailable" = the meter couldn't be read. */
export type AiBudgetResult = "ok" | "busy" | "unavailable";

export const UNITS_PER_DOLLAR = 10_000;

/** Deliberately low chars-per-token, so token estimates run high. */
export const CHARS_PER_TOKEN_ESTIMATE = 3;

/** List prices, dollars per million tokens (Anthropic cached 2026-06-24;
 * Gemini per plans/september-2026/COSTS.md). gemini-2.5-pro's >200k-token
 * tier doesn't apply: gemini-proxy caps input at 120k characters. */
export const MODEL_PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-embedding-001": { input: 0.15, output: 0 },
};

/** Anything not listed above is priced like an Opus-tier model. */
export const UNKNOWN_MODEL_PRICE = { input: 5, output: 25 } as const;

/** One image-only page through gemini-2.5-flash OCR: about 340 tokens in and
 * typically ~500 out ($0.00135, COSTS.md §1). 20 units ($0.002) leaves room
 * for dense pages without charging the full 8,192-token output ceiling, which
 * would make one course's OCR look like a day's budget. */
export const OCR_PAGE_UNITS = 20;

/** TypeSafe publishes no per-request price we've verified; a flat placeholder. */
export const TYPESAFE_REQUEST_UNITS = 100;

export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

/** Estimated units for one model call: every input character plus the full
 * output allowance. Never less than 1. */
export function estimateModelUnits(model: string, inputChars: number, maxOutputTokens: number): number {
  const price = Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : UNKNOWN_MODEL_PRICE;
  const output = Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : 0;
  const dollars = (estimateTokens(inputChars) * price.input + output * price.output) / 1_000_000;
  // Round away float noise (0.105 * 10,000 = 1050.0000000000002) before ceil.
  const units = Math.round(dollars * UNITS_PER_DOLLAR * 1_000_000) / 1_000_000;
  return Math.max(1, Math.ceil(units));
}

/** Estimated units for embedding texts totalling `totalChars` characters. */
export function estimateEmbeddingUnits(totalChars: number): number {
  return estimateModelUnits("gemini-embedding-001", totalChars, 0);
}

/**
 * Claims `units` from today's budget for `provider`. `userId` is the signed-in
 * caller (null when there isn't one; it's only used for the allowlist).
 * Returns "busy" when the budget is spent, and "unavailable" on any RPC error,
 * thrown exception, unexpected reply or invalid `units`, so callers can fail
 * closed on anything but "ok".
 */
export async function claimAiBudget(
  client: RpcClient,
  provider: AiProvider,
  userId: string | null,
  units: number,
): Promise<AiBudgetResult> {
  if (!Number.isFinite(units) || units < 0) return "unavailable";
  try {
    const { data, error } = await client.rpc("claim_ai_budget", {
      p_provider: provider,
      p_user_id: userId,
      p_units: Math.ceil(units),
    });
    if (error) {
      const message = typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "unknown error";
      console.error(`[ai-budget] claim_ai_budget failed for ${provider}: ${message.slice(0, 200)}`);
      return "unavailable";
    }
    if (data === "allow") return "ok";
    if (data === "deny") {
      console.warn(`[ai-budget] ${provider} daily budget reached; refusing ${Math.ceil(units)} units`);
      return "busy";
    }
    console.error(`[ai-budget] claim_ai_budget returned an unexpected value for ${provider}`);
    return "unavailable";
  } catch (error) {
    console.error(`[ai-budget] claim_ai_budget threw for ${provider}:`, error instanceof Error ? error.message : error);
    return "unavailable";
  }
}

// TODO(copy): no COPY.md key yet; Fable to confirm. Says what's happening to
// the user, not why.
export const AI_BUSY_MESSAGE = "Things are busier than usual right now. Please try again later.";

/** Seconds until the next UTC midnight, when the daily budgets reset. */
export function secondsUntilUtcReset(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** The 503 a function returns when claimAiBudget isn't "ok". `headers` is how
 * callers pass their CORS headers through. */
export function aiBusyResponse(opts?: { headers?: Record<string, string>; now?: Date }): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Retry-After": String(secondsUntilUtcReset(opts?.now)),
  };
  Object.assign(headers, opts?.headers ?? {});
  return new Response(JSON.stringify({ error: AI_BUSY_MESSAGE, code: "busy" }), {
    status: 503,
    headers,
  });
}
