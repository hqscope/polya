import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AI_BUSY_CODE,
  AI_BUSY_POLYA_IMPORT_DETAIL,
  AI_BUSY_POLYA_IMPORT_QUEUE,
  AI_BUSY_POLYA_IMPORT_STATUS,
  AI_BUSY_POLYA_SEARCH,
  AI_BUSY_POLYA_SEARCH_HINT,
  AI_BUSY_POLYA_TUTOR,
  AI_BUSY_POLYA_TUTOR_SHORT,
  isAiBusy,
} from "../src/lib/ai-busy.ts";

// `FunctionError` (`@/lib/functions`) is duck-typed here rather than
// imported: that module pulls in the Supabase browser client via a `@/`
// path alias Node's test runner (no bundler) can't resolve. Its real shape
// is `{ message, code, status }`, exactly what `isAiBusy` reads.
class FakeFunctionError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

test("isAiBusy recognizes the code, not the message text", () => {
  assert.equal(isAiBusy({ code: "busy" }), true);
  assert.equal(isAiBusy(new FakeFunctionError("Things are busier than usual.", "busy", 503)), true);
  assert.equal(isAiBusy(AI_BUSY_CODE), false, "a bare string is not the shape it checks");
});

test("isAiBusy rejects everything else, including a lookalike message", () => {
  assert.equal(isAiBusy({ code: "internal" }), false);
  assert.equal(isAiBusy(new FakeFunctionError("busy", "internal", 500)), false);
  assert.equal(isAiBusy(new Error("Things are busier than usual right now.")), false);
  assert.equal(isAiBusy(null), false);
  assert.equal(isAiBusy(undefined), false);
  assert.equal(isAiBusy("busy"), false);
  assert.equal(isAiBusy(503), false);
});

test("every surface's copy fits COPY.md §11's character budget", () => {
  const budgets: Array<[string, number]> = [
    [AI_BUSY_POLYA_TUTOR, 170],
    [AI_BUSY_POLYA_TUTOR_SHORT, 60],
    [AI_BUSY_POLYA_SEARCH, 90],
    [AI_BUSY_POLYA_SEARCH_HINT, 45],
    [AI_BUSY_POLYA_IMPORT_STATUS, 36],
    [AI_BUSY_POLYA_IMPORT_DETAIL, 160],
    [AI_BUSY_POLYA_IMPORT_QUEUE, 70],
  ];
  for (const [text, limit] of budgets) {
    assert.ok(text.length <= limit, `"${text}" is ${text.length} chars, over its ${limit}-char budget`);
  }
});

test("none of the busy copy uses banned implementation words", () => {
  const banned = ["budget", "limit", "cost", "quota", "provider", "model"];
  for (const text of [
    AI_BUSY_POLYA_TUTOR,
    AI_BUSY_POLYA_TUTOR_SHORT,
    AI_BUSY_POLYA_SEARCH,
    AI_BUSY_POLYA_SEARCH_HINT,
    AI_BUSY_POLYA_IMPORT_STATUS,
    AI_BUSY_POLYA_IMPORT_DETAIL,
    AI_BUSY_POLYA_IMPORT_QUEUE,
  ]) {
    const lower = text.toLowerCase();
    for (const word of banned) {
      assert.ok(!lower.includes(word), `"${text}" mentions "${word}"`);
    }
  }
});
