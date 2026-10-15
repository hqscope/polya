import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";

import {
  excludedRolesFor,
  normalizeMode,
  rulesReminder,
  studyRulesFor,
  type PolicyMode,
} from "../agent/lib/study-rules.ts";

const MODES: PolicyMode[] = ["open", "guided", "practice", "review"];

describe("study rules", () => {
  it("falls back to guided for unknown or missing modes", () => {
    assert.equal(normalizeMode(null), "guided");
    assert.equal(normalizeMode(undefined), "guided");
    assert.equal(normalizeMode("cheat"), "guided");
    for (const mode of MODES) assert.equal(normalizeMode(mode), mode);
  });

  it("tells the assistant to re-check the mode and never give a bare answer, in every mode", () => {
    for (const mode of MODES) {
      const rules = studyRulesFor(mode);
      assert.equal(rules.mode, mode);
      assert.ok(rules.how_to_help.some((line) => line.includes("get_course_rules again")), mode);
      assert.ok(rules.how_to_help.some((line) => line.includes("Never reply with a bare answer")), mode);
    }
  });

  it("treats each part of a problem as its own question in guided and practice", () => {
    for (const mode of ["guided", "practice"] as const) {
      assert.ok(studyRulesFor(mode).how_to_help.some((line) => line.includes("its own question")), mode);
      assert.match(rulesReminder(mode), /Each part of a problem is its own question/);
    }
    assert.doesNotMatch(rulesReminder("open"), /Each part/);
  });

  it("holds back full solutions in guided and answers in practice", () => {
    assert.deepEqual(studyRulesFor("guided").not_allowed, [
      "A full solution to a problem before the student has shown their own attempt",
    ]);
    assert.ok(studyRulesFor("practice").not_allowed.includes("Stating an answer before the student commits to one"));
    assert.deepEqual(studyRulesFor("open").not_allowed, []);
  });

  it("withholds answer keys only in practice", () => {
    assert.deepEqual(excludedRolesFor("practice"), ["solution_key"]);
    for (const mode of ["open", "guided", "review"] as const) assert.deepEqual(excludedRolesFor(mode), []);
  });
});

// The copy must match Polya's source of truth. The source lives outside this deployable, so the
// check runs only where the whole polya repo is checked out.
const SOURCE = new URL("../../supabase/functions/_shared/study-rules.ts", import.meta.url);

describe("study rules copy", { skip: !existsSync(SOURCE) && "polya source not present" }, () => {
  it("matches polya/supabase/functions/_shared/study-rules.ts", async () => {
    const source = (await import(SOURCE.href)) as {
      studyRulesFor: typeof studyRulesFor;
      rulesReminder: typeof rulesReminder;
      excludedRolesFor: typeof excludedRolesFor;
      normalizeMode: typeof normalizeMode;
    };
    for (const mode of MODES) {
      assert.deepEqual(studyRulesFor(mode), source.studyRulesFor(mode), mode);
      assert.equal(rulesReminder(mode), source.rulesReminder(mode), mode);
      assert.deepEqual(excludedRolesFor(mode), source.excludedRolesFor(mode), mode);
    }
    for (const raw of [null, undefined, "", "bogus", ...MODES]) {
      assert.equal(normalizeMode(raw), source.normalizeMode(raw));
    }
  });
});
