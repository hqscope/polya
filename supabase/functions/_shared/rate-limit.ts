// This file is intentionally duplicated byte-for-byte in three repos:
//   - scope-platform/apps/extension/supabase/functions/_shared/rate-limit.ts
//   - lectra-ios/backend/functions/_shared/rate-limit.ts
//   - polya/supabase/functions/_shared/rate-limit.ts
// It has no repo-specific imports so the copies can stay identical. If you
// change this file, change all three, and re-run rate-limit_test.ts (also
// duplicated the same way) in each.
//
// Thin wrappers around the shared SECURITY DEFINER functions from
// `lectra-ios/backend/migrations/20260924022256_shared_rate_limit.sql`:
//   - claim_rate_limit(subject, bucket, limit, window_seconds) -> boolean
//     Fixed window, fails closed. Windows are capped at 1 day; anything
//     longer returns false. Use `withinDailyCap` / usage_daily for daily caps.
//   - increment_usage_daily(user_id, bucket, units) -> bigint
//     Returns the new daily total (UTC), and raises on bad input.
// Both are service_role-only RPCs, so every caller here must be constructed
// with a service-role Supabase client.
//
// Subject conventions (pick one per call site):
//   user:<uuid>   - a signed-in user
//   anon:<id>     - an anonymous/device id with no user account
//   ip:<addr>     - last resort, keyed on the caller's IP
// Bucket conventions: name buckets per function and window, e.g.
// "gemini:hour", "gemini:day", "claude-proxy:day".

/** Minimal shape of the Supabase client this file needs: just `rpc`, so it
 * works against any repo's supabase-js version without importing it. */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

/** Calls `claim_rate_limit`. Any RPC error, thrown exception, or a result
 * that isn't literally `true` denies the request (fails closed). */
export async function claimRateLimit(
  client: RpcClient,
  subject: string,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("claim_rate_limit", {
      p_subject: subject,
      p_bucket: bucket,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** Calls `increment_usage_daily`. Returns the new daily total, or `null` on
 * any RPC error or thrown exception (including the function's own raise on
 * bad input). */
export async function incrementUsageDaily(
  client: RpcClient,
  userId: string,
  bucket: string,
  units = 1,
): Promise<number | null> {
  try {
    const { data, error } = await client.rpc("increment_usage_daily", {
      p_user_id: userId,
      p_bucket: bucket,
      p_units: units,
    });
    if (error) return null;
    if (typeof data === "number") return data;
    if (typeof data === "bigint") return Number(data);
    if (typeof data === "string" && data.trim() !== "" && !Number.isNaN(Number(data))) {
      return Number(data);
    }
    return null;
  } catch {
    return null;
  }
}

/** Increments today's usage for `userId`/`bucket` and reports whether the new
 * total is within `cap`. A `null` total (any failure incrementing) denies. */
export async function withinDailyCap(
  client: RpcClient,
  userId: string,
  bucket: string,
  cap: number,
  units = 1,
): Promise<boolean> {
  const total = await incrementUsageDaily(client, userId, bucket, units);
  return total !== null && total <= cap;
}

/** A 429 response with a friendly, user-facing JSON body. `headers` is how
 * callers pass their own CORS headers through; they're merged in after the
 * defaults, and `retryAfterSeconds` (when given) sets `Retry-After`. */
export function rateLimitedResponse(opts?: {
  message?: string;
  retryAfterSeconds?: number;
  headers?: Record<string, string>;
}): Response {
  const message = opts?.message ?? "You've hit today's limit. Try again later.";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts?.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(opts.retryAfterSeconds);
  }
  Object.assign(headers, opts?.headers ?? {});
  return new Response(JSON.stringify({ error: message, code: "rate_limited" }), {
    status: 429,
    headers,
  });
}
