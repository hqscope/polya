import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TRANSIENT_BACKOFF_MS,
  transientBackoffMs,
} from "../supabase/functions/_shared/backoff.ts";
import {
  GeminiTransientError,
  isDailyQuotaBody,
  parseRetryDelayMs,
} from "../supabase/functions/_shared/embeddings.ts";

test("schedule walks the ladder and clamps at both ends", () => {
  assert.equal(transientBackoffMs(1), 2 * 60_000);
  assert.equal(transientBackoffMs(2), 10 * 60_000);
  assert.equal(transientBackoffMs(3), 30 * 60_000);
  assert.equal(transientBackoffMs(4), 2 * 3_600_000);
  assert.equal(transientBackoffMs(7), 24 * 3_600_000);
  // Beyond the ladder stays at the last rung; nonsense inputs clamp to the first.
  assert.equal(transientBackoffMs(50), TRANSIENT_BACKOFF_MS[TRANSIENT_BACKOFF_MS.length - 1]);
  assert.equal(transientBackoffMs(0), TRANSIENT_BACKOFF_MS[0]);
  assert.equal(transientBackoffMs(-3), TRANSIENT_BACKOFF_MS[0]);
});

test("an explicit Retry-After raises but never lowers the wait", () => {
  assert.equal(transientBackoffMs(1, { retryAfterMs: 9 * 60_000 }), 9 * 60_000);
  assert.equal(transientBackoffMs(4, { retryAfterMs: 1_000 }), 2 * 3_600_000);
  assert.equal(transientBackoffMs(1, { retryAfterMs: null }), 2 * 60_000);
});

test("a daily quota violation waits at least 4h even on early attempts", () => {
  assert.equal(transientBackoffMs(1, { daily: true }), 4 * 3_600_000);
  assert.equal(transientBackoffMs(2, { daily: true }), 4 * 3_600_000);
  // Later rungs already exceed the floor and win.
  assert.equal(transientBackoffMs(5, { daily: true }), 6 * 3_600_000);
});

test("daily-quota detection matches Gemini free-tier quota ids", () => {
  assert.equal(
    isDailyQuotaBody('"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"'),
    true,
  );
  assert.equal(isDailyQuotaBody('"quotaId": "EmbedContentRequestsPerMinutePerProject"'), false);
  assert.equal(isDailyQuotaBody(""), false);
});

test("retryDelay hints parse from header or body", () => {
  assert.equal(parseRetryDelayMs("30", ""), 30_000);
  assert.equal(parseRetryDelayMs(null, '"retryDelay": "12s"'), 12_000);
  assert.equal(parseRetryDelayMs(null, '"retryDelay": "0.8s"'), 800);
  assert.equal(parseRetryDelayMs(null, "no hint here"), null);
});

test("GeminiTransientError carries duck-typed transient hints", () => {
  const err = new GeminiTransientError("Gemini embed failed (429): quota", {
    retryAfterMs: 5_000,
    daily: true,
  });
  assert.equal(err.transient, true);
  assert.equal(err.retryAfterMs, 5_000);
  assert.equal(err.daily, true);
  // Defaults stay backward-compatible with the bare-message constructor.
  const bare = new GeminiTransientError("boom");
  assert.equal(bare.retryAfterMs, null);
  assert.equal(bare.daily, false);
});
