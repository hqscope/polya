import { test } from "node:test";
import assert from "node:assert/strict";

import { checkSearchQuery, SEARCH_QUERY_MAX_CHARS } from "../supabase/functions/_shared/search-limits.ts";

test("query cap is 2,000 characters of trimmed text", () => {
  assert.equal(SEARCH_QUERY_MAX_CHARS, 2_000);
  assert.equal(checkSearchQuery("binomial distribution"), "ok");
  assert.equal(checkSearchQuery("x".repeat(2_000)), "ok");
  assert.equal(checkSearchQuery(`  ${"x".repeat(2_000)}  `), "ok", "surrounding whitespace doesn't count");
  assert.equal(checkSearchQuery("x".repeat(2_001)), "too_long");
});

test("missing or non-string queries are rejected as missing", () => {
  assert.equal(checkSearchQuery(undefined), "missing");
  assert.equal(checkSearchQuery(""), "missing");
  assert.equal(checkSearchQuery("   "), "missing");
  assert.equal(checkSearchQuery(42), "missing");
  assert.equal(checkSearchQuery({ text: "hi" }), "missing");
});
