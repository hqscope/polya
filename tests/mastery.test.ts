import { test } from "node:test";
import assert from "node:assert/strict";

import { parseVerdictLine } from "../supabase/functions/_shared/prompts.ts";

test("parseVerdictLine accepts the three verdicts, case-insensitively", () => {
  assert.equal(parseVerdictLine("VERDICT: pass"), "pass");
  assert.equal(parseVerdictLine("VERDICT: partial"), "partial");
  assert.equal(parseVerdictLine("VERDICT: fail"), "fail");
  assert.equal(parseVerdictLine("verdict: Pass"), "pass");
  assert.equal(parseVerdictLine("  VERDICT: fail  "), "fail");
});

test("parseVerdictLine rejects anything else", () => {
  assert.equal(parseVerdictLine(""), null);
  assert.equal(parseVerdictLine("VERDICT: maybe"), null);
  assert.equal(parseVerdictLine("VERDICT: pass, nice work"), null);
  assert.equal(parseVerdictLine("Great job! You passed."), null);
  assert.equal(parseVerdictLine("PASS"), null);
});
