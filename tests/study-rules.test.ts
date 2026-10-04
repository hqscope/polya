import { test } from "node:test";
import assert from "node:assert/strict";

import {
  excludedRolesFor,
  normalizeMode,
  rulesReminder,
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

test("every mode tells the assistant to explain, never a bare answer", () => {
  for (const mode of ["open", "guided", "practice", "review"] as const) {
    assert.ok(studyRulesFor(mode).how_to_help.some((line) => /never reply with a bare answer/i.test(line)));
    assert.match(rulesReminder(mode), /never give a bare answer/i);
    assert.ok(studyRulesFor(mode).how_to_help.some((line) => /check get_course_rules again/.test(line)));
  }
});

test("guided and practice treat each part of a problem as its own question", () => {
  for (const mode of ["guided", "practice"] as const) {
    assert.ok(studyRulesFor(mode).how_to_help.some((line) => line.includes("what about the rest")));
    assert.match(rulesReminder(mode), /each part of a problem/i);
  }
  assert.ok(studyRulesFor("practice").how_to_help.some((line) => /yes\/no question/.test(line)));
});
