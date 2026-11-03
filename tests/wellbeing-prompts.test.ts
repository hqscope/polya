import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCoachSystemBlocks, COACH_CHARTER } from "../supabase/functions/_shared/coach-prompts.ts";
import { buildSystemBlocks, CHARTER, HOLD_BACK_RULES, WELLBEING_RULES } from "../supabase/functions/_shared/prompts.ts";

test("the tutor and the exam coach both carry the hold-back rules", () => {
  assert.ok(CHARTER.includes(HOLD_BACK_RULES));
  assert.ok(COACH_CHARTER.includes(HOLD_BACK_RULES));
});

test("the tutor and the exam coach both carry the distress rules", () => {
  assert.ok(CHARTER.includes(WELLBEING_RULES));
  assert.ok(COACH_CHARTER.includes(WELLBEING_RULES));
  assert.match(WELLBEING_RULES, /988/);
  assert.ok(buildCoachSystemBlocks("STAT 134", "guided", null)[0]!.text.includes(WELLBEING_RULES));
  assert.ok(buildSystemBlocks("STAT 134", "guided", null)[0]!.text.includes(WELLBEING_RULES));
});

test("the coach is told not to use pressure language about the exam date", () => {
  assert.match(COACH_CHARTER, /Never use pressure language/);
  assert.doesNotMatch(COACH_CHARTER, /Be realistic about the time left/);
  assert.match(COACH_CHARTER, /Never size up the student's situation/);
  assert.match(COACH_CHARTER, /never ask the student to type out course material/);
});
