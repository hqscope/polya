// Cross-invocation retry backoff for transient import failures, written to
// polya_sources.next_attempt_at (the claim RPCs skip gated rows). Stretches to
// ~45h total so retries survive a *daily* quota reset, instead of burning every
// attempt inside the 2-minute claim lease. Pure module (no Deno globals) so
// Node's test runner covers it directly.

export const TRANSIENT_BACKOFF_MS: readonly number[] = [
  2 * 60_000, // attempt 1 → wait 2m
  10 * 60_000, // 10m
  30 * 60_000, // 30m
  2 * 3_600_000, // 2h
  6 * 3_600_000, // 6h
  12 * 3_600_000, // 12h
  24 * 3_600_000, // 24h
];

export interface TransientHint {
  retryAfterMs?: number | null;
  daily?: boolean;
}

// Provider hints only ever *raise* the wait: an explicit Retry-After is a
// floor, and a per-day quota violation waits at least 4h regardless of how
// early in the schedule it happens.
export function transientBackoffMs(attempts: number, hint?: TransientHint): number {
  const index = Math.min(Math.max(attempts - 1, 0), TRANSIENT_BACKOFF_MS.length - 1);
  let ms = TRANSIENT_BACKOFF_MS[index]!;
  if (hint?.retryAfterMs != null) ms = Math.max(ms, hint.retryAfterMs);
  if (hint?.daily) ms = Math.max(ms, 4 * 3_600_000);
  return ms;
}
