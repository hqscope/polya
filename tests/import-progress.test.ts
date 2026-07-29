import { test } from "node:test";
import assert from "node:assert/strict";

import { importIsComplete, importPending, type ImportProgress } from "../src/lib/types.ts";

function progress(p: Partial<ImportProgress>): ImportProgress {
  return {
    total: 0,
    queued: 0,
    fetching: 0,
    parsing: 0,
    embedding: 0,
    ready: 0,
    failed: 0,
    skipped: 0,
    needs_ocr: 0,
    ...p,
  };
}

test("importPending counts only the non-terminal (still-working) states", () => {
  assert.equal(
    importPending(progress({ queued: 2, fetching: 1, parsing: 3, embedding: 1, ready: 5 })),
    7,
  );
  // ready/failed/skipped/needs_ocr are terminal — nothing left to do.
  assert.equal(importPending(progress({ ready: 5, failed: 2, skipped: 1, needs_ocr: 1 })), 0);
});

test("importIsComplete: true only when work exists and none is pending", () => {
  assert.equal(importIsComplete(progress({ total: 0 })), false); // nothing queued yet
  assert.equal(importIsComplete(progress({ total: 4, ready: 3, failed: 1 })), true); // done, one unreadable
  assert.equal(importIsComplete(progress({ total: 4, ready: 2, parsing: 2 })), false); // still working
});
