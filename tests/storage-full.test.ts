import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatStorageBytes,
  isDefinitiveStorageFullError,
  isPossibleStorageFullError,
  parseStorageUsage,
  storageFullCopy,
  storageFullFromCheck,
} from "../src/lib/storage-full.ts";

const rlsRefusal = {
  name: "StorageApiError",
  message: "new row violates row-level security policy",
  statusCode: "403",
  status: 400,
};

test("parses only the usage fields it needs", () => {
  assert.deepEqual(
    parseStorageUsage({
      tier: "free",
      used_bytes: 512_000_000,
      quota_bytes: 500_000_000,
      over_quota: true,
      top_documents: [{ anything: "goes" }],
    }),
    { usedBytes: 512_000_000, quotaBytes: 500_000_000, overQuota: true },
  );
  assert.equal(parseStorageUsage(null), null);
  assert.equal(parseStorageUsage({ used_bytes: 1, quota_bytes: 2 }), null);
  assert.equal(parseStorageUsage({ used_bytes: "x", quota_bytes: 2, over_quota: false }), null);
});

test("only storage-shaped failures are worth a usage check", () => {
  assert.equal(isPossibleStorageFullError(rlsRefusal), true);
  assert.equal(isPossibleStorageFullError({ code: "storage_full", message: "x" }), true);
  assert.equal(isPossibleStorageFullError(new Error("new row violates row level security")), true);
  assert.equal(isPossibleStorageFullError({ code: "no_connection", status: 400, message: "x" }), false);
  assert.equal(isPossibleStorageFullError(new Error("Failed to fetch")), false);
  assert.equal(isPossibleStorageFullError(null), false);
  assert.equal(isPossibleStorageFullError("storage is full"), false);
});

test("an explicit code is definitive; the policy refusal is not", () => {
  assert.equal(isDefinitiveStorageFullError({ code: "storage_full" }), true);
  assert.equal(isDefinitiveStorageFullError({ code: "quota_exceeded" }), true);
  assert.equal(isDefinitiveStorageFullError(rlsRefusal), false);
});

test("the usage check decides, except when the server said so outright", () => {
  const over = { usedBytes: 600e6, quotaBytes: 500e6, overQuota: true };
  const under = { usedBytes: 100e6, quotaBytes: 500e6, overQuota: false };

  assert.deepEqual(storageFullFromCheck(rlsRefusal, over), { usage: over });
  // Room left: the refusal was something else, so show the original error.
  assert.equal(storageFullFromCheck(rlsRefusal, under), null);
  // Couldn't read usage: don't claim storage is full on a guess.
  assert.equal(storageFullFromCheck(rlsRefusal, null), null);
  // The server said storage_full: say so, without numbers we can't back up.
  assert.deepEqual(storageFullFromCheck({ code: "storage_full" }, null), { usage: null });
  assert.deepEqual(storageFullFromCheck({ code: "storage_full" }, under), { usage: null });
});

test("sizes read as plans are sold, never in bytes", () => {
  assert.equal(formatStorageBytes(500_000_000), "500 MB");
  assert.equal(formatStorageBytes(25_000_000_000), "25 GB");
  assert.equal(formatStorageBytes(1_835_580_897), "1.8 GB");
  assert.equal(formatStorageBytes(50_000_000_000), "50 GB");
  assert.equal(formatStorageBytes(8_054), "8 KB");
  assert.equal(formatStorageBytes(12), "1 KB");
  assert.equal(formatStorageBytes(0), "0 KB");
  assert.equal(formatStorageBytes(Number.NaN), "0 KB");
});

test("copy fills in the numbers and names no mechanics", () => {
  const copy = storageFullCopy({ usedBytes: 512_000_000, quotaBytes: 500_000_000, overQuota: true });
  assert.equal(copy.title, "Couldn't import");
  assert.match(copy.body, /^Your Lectra storage is full \(512 MB of 500 MB\)\./);
  assert.match(copy.body, /Nothing you've already imported is affected\.$/);
  assert.equal(copy.action, "How to Get More Storage");

  const noNumbers = storageFullCopy(null);
  assert.match(noNumbers.body, /^Your Lectra storage is full\. Free up space/);

  for (const text of [copy.title, copy.body, copy.action, copy.hint, noNumbers.body]) {
    assert.doesNotMatch(text, /quota|bucket|server|database|supabase|row-level|token/i);
  }
});
