import { test } from "node:test";
import assert from "node:assert/strict";

import { checkTutorMessage, TUTOR_MESSAGE_MAX_CHARS } from "../supabase/functions/_shared/tutor-limits.ts";

test("message cap is 8,000 characters of trimmed text", () => {
  assert.equal(TUTOR_MESSAGE_MAX_CHARS, 8_000);
  assert.equal(checkTutorMessage("What is a binomial distribution?"), "ok");
  assert.equal(checkTutorMessage("x".repeat(8_000)), "ok");
  assert.equal(checkTutorMessage(`  ${"x".repeat(8_000)}  `), "ok", "surrounding whitespace doesn't count");
  assert.equal(checkTutorMessage("x".repeat(8_001)), "too_long");
});

test("missing or non-string messages are rejected as missing", () => {
  assert.equal(checkTutorMessage(undefined), "missing");
  assert.equal(checkTutorMessage(""), "missing");
  assert.equal(checkTutorMessage("   "), "missing");
  assert.equal(checkTutorMessage(42), "missing");
  assert.equal(checkTutorMessage({ text: "hi" }), "missing");
});
