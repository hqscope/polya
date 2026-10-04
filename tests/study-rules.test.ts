import { test } from "node:test";
import assert from "node:assert/strict";

import {
  excludedRolesFor,
  normalizeMode,
  studyRulesFor,
} from "../supabase/functions/_shared/study-rules.ts";

test("normalizeMode falls back to guided", () => {
  assert.equal(normalizeMode("practice"), "practice");
  assert.equal(normalizeMode(null), "guided");
  assert.equal(normalizeMode("anything"), "guided");
});

test("only practice withholds solution keys", () => {
  assert.deepEqual(excludedRolesFor("practice"), ["solution_key"]);
  for (const mode of ["open", "guided", "review"] as const) {
    assert.deepEqual(excludedRolesFor(mode), []);
  }
});

test("every mode has a label and summary; restrictive modes say what is off limits", () => {
  for (const mode of ["open", "guided", "practice", "review"] as const) {
    const rules = studyRulesFor(mode);
    assert.equal(rules.mode, mode);
    assert.ok(rules.label && rules.summary);
  }
  assert.ok(studyRulesFor("guided").not_allowed.length > 0);
  assert.ok(studyRulesFor("practice").not_allowed.length > 0);
});
