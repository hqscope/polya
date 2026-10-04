import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AiBudgetBusyError,
  chargeEmbeddingBudget,
  chargeImportUnits,
  DAILY_OCR_PAGE_CAP,
  DAILY_PDF_PAGE_CAP,
  DailyImportCapError,
  importCapBucket,
  ImportMeterUnavailableError,
  msUntilUtcMidnight,
} from "../supabase/functions/_shared/import-caps.ts";
import { transientBackoffMs } from "../supabase/functions/_shared/backoff.ts";
import type { RpcClient } from "../supabase/functions/_shared/rate-limit.ts";

// Fake increment_usage_daily: per-bucket running totals, or a hard failure.
// claim_ai_budget (the project-wide budget, R-5) answers `budget`.
function meter(
  opts: { fail?: boolean; start?: Record<string, number>; budget?: "allow" | "deny" | "error" } = {},
) {
  const totals = new Map<string, number>(Object.entries(opts.start ?? {}));
  const calls: Array<Record<string, unknown>> = [];
  const client: RpcClient = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, ...args });
      if (fn === "claim_ai_budget") {
        const budget = opts.budget ?? "allow";
        return Promise.resolve(
          budget === "error" ? { data: null, error: { message: "down" } } : { data: budget, error: null },
        );
      }
      if (opts.fail) return Promise.resolve({ data: null, error: { message: "down" } });
      const key = String(args.p_bucket);
      const next = (totals.get(key) ?? 0) + Number(args.p_units);
      totals.set(key, next);
      return Promise.resolve({ data: next, error: null });
    },
  };
  return { client, calls, totals };
}

test("caps are sized for ordinary term imports", () => {
  // COSTS.md: ~1,620 pages and ~320 OCR pages per typical course.
  assert.ok(DAILY_PDF_PAGE_CAP >= 1_620 * 5, "five typical courses of pages in one day");
  assert.ok(DAILY_OCR_PAGE_CAP >= 320 * 5, "five typical courses of OCR in one day");
  assert.ok(DAILY_OCR_PAGE_CAP >= 1_620, "one fully image-only course in one day");
  assert.ok(DAILY_OCR_PAGE_CAP * 0.00135 < 3, "worst-case OCR spend under $3/user/day");
});

test("charges the right bucket and units, and allows up to the cap", async () => {
  const { client, calls } = meter();
  await chargeImportUnits(client, "u1", "pages", 10);
  await chargeImportUnits(client, "u1", "ocr", 3);
  assert.equal(calls[0].fn, "increment_usage_daily");
  assert.equal(calls[0].p_bucket, importCapBucket("pages").bucket);
  assert.equal(calls[0].p_units, 10);
  assert.equal(calls[1].p_bucket, importCapBucket("ocr").bucket);
  assert.equal(calls[1].p_units, 3);
  // OCR also draws on the project-wide Gemini budget: 3 pages x 20 units.
  assert.equal(calls[2].fn, "claim_ai_budget");
  assert.equal(calls[2].p_provider, "gemini");
  assert.equal(calls[2].p_user_id, "u1");
  assert.equal(calls[2].p_units, 60);
  assert.equal(calls.length, 3, "plain pages don't touch the AI budget");

  const atCap = meter({ start: { [importCapBucket("pages").bucket]: DAILY_PDF_PAGE_CAP - 10 } });
  await chargeImportUnits(atCap.client, "u1", "pages", 10); // lands exactly on the cap
});

test("over the cap throws a daily, transient error that waits for UTC midnight", async () => {
  const now = new Date(Date.UTC(2026, 8, 24, 18, 0, 0)); // 6h before midnight
  const { client } = meter({ start: { [importCapBucket("ocr").bucket]: DAILY_OCR_PAGE_CAP } });
  await assert.rejects(
    () => chargeImportUnits(client, "u1", "ocr", 1, now),
    (err: unknown) => {
      assert.ok(err instanceof DailyImportCapError);
      assert.equal(err.transient, true);
      assert.equal(err.daily, true);
      assert.equal(err.unit, "ocr");
      assert.equal(err.retryAfterMs, 6 * 3_600_000);
      // The pump's backoff honours it (and never waits less than the daily floor).
      assert.equal(transientBackoffMs(1, err), 6 * 3_600_000);
      return true;
    },
  );
});

test("a meter failure fails closed as a short retry, not a day-long wait", async () => {
  const { client } = meter({ fail: true });
  await assert.rejects(
    () => chargeImportUnits(client, "u1", "pages", 10),
    (err: unknown) => {
      assert.ok(err instanceof ImportMeterUnavailableError);
      assert.equal(err.transient, true);
      assert.equal((err as { daily?: boolean }).daily, undefined);
      return true;
    },
  );
});

test("zero units charge nothing", async () => {
  const { client, calls } = meter();
  await chargeImportUnits(client, "u1", "ocr", 0);
  assert.equal(calls.length, 0);
});

test("msUntilUtcMidnight", () => {
  assert.equal(msUntilUtcMidnight(new Date(Date.UTC(2026, 0, 1, 23, 59, 0))), 60_000);
  assert.equal(msUntilUtcMidnight(new Date(Date.UTC(2026, 0, 1, 0, 0, 0))), 24 * 3_600_000);
});

test("OCR over the project-wide budget waits for the UTC reset and gates the queue", async () => {
  const now = new Date(Date.UTC(2026, 8, 24, 20, 0, 0)); // 4h before midnight
  const { client } = meter({ budget: "deny" });
  await assert.rejects(
    () => chargeImportUnits(client, "u1", "ocr", 5, now),
    (err: unknown) => {
      assert.ok(err instanceof AiBudgetBusyError);
      assert.equal(err.transient, true);
      assert.equal(err.daily, true);
      assert.equal(err.retryAfterMs, 4 * 3_600_000);
      return true;
    },
  );
});

test("an AI budget meter failure is a short retry, not a day-long wait", async () => {
  const { client } = meter({ budget: "error" });
  await assert.rejects(
    () => chargeImportUnits(client, "u1", "ocr", 5),
    (err: unknown) => err instanceof ImportMeterUnavailableError,
  );
  await assert.rejects(
    () => chargeEmbeddingBudget(client, "u1", ["some text"]),
    (err: unknown) => err instanceof ImportMeterUnavailableError,
  );
});

test("embedding charges are sized from the text and skip empty batches", async () => {
  const { client, calls } = meter();
  await chargeEmbeddingBudget(client, "u1", []);
  assert.equal(calls.length, 0);
  // 2.1M chars = 700k tokens at $0.15/M = $0.105 = 1,050 units.
  await chargeEmbeddingBudget(client, "u1", ["x".repeat(1_050_000), "y".repeat(1_050_000)]);
  assert.equal(calls[0].fn, "claim_ai_budget");
  assert.equal(calls[0].p_provider, "gemini");
  assert.equal(calls[0].p_units, 1_050);

  const busy = meter({ budget: "deny" });
  await assert.rejects(
    () => chargeEmbeddingBudget(busy.client, "u1", ["text"]),
    (err: unknown) => err instanceof AiBudgetBusyError,
  );
});
