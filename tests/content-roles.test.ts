import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyContentRole,
  isAnswerKeyLike,
  queryAllowsAnswerKeys,
} from "../supabase/functions/_shared/content-roles.ts";

test("isAnswerKeyLike flags solution/answer-key material", () => {
  assert.ok(isAnswerKeyLike({ title: "Problem Set 3 Answer Key" }));
  assert.ok(isAnswerKeyLike({ title: "ps3_solutions.pdf" }));
  assert.ok(isAnswerKeyLike({ folderPath: "Exams > Solutions" }));
  assert.ok(isAnswerKeyLike({ title: "su26_final_sols" }));
  assert.ok(isAnswerKeyLike({ title: "hw3 sols" }));
  assert.ok(isAnswerKeyLike({ title: "fa25_mt2_sol" }));
  assert.ok(isAnswerKeyLike({ title: "soln-section9" }));
  assert.ok(isAnswerKeyLike({ title: "F26_Stat_134_midterm-practice1-brief-soln" }));
  assert.ok(isAnswerKeyLike({ title: "hw2_solns" }));
  assert.ok(!isAnswerKeyLike({ title: "Solstice reading" }));
  assert.ok(!isAnswerKeyLike({ title: "Lecture 7 — Cellular Respiration" }));
});

test("queryAllowsAnswerKeys detects intent to see solutions", () => {
  assert.ok(queryAllowsAnswerKeys("show me the solution to problem 4"));
  assert.ok(queryAllowsAnswerKeys("what's the answer key"));
  assert.ok(!queryAllowsAnswerKeys("help me understand cellular respiration"));
});

test("classifyContentRole maps origin and answer-keys to roles", () => {
  assert.equal(classifyContentRole({ origin: "canvas_syllabus" }), "syllabus");
  assert.equal(classifyContentRole({ origin: "canvas_assignment" }), "assignment");
  assert.equal(
    classifyContentRole({ origin: "canvas_file", title: "Midterm Solutions" }),
    "solution_key",
  );
  assert.equal(
    classifyContentRole({ origin: "canvas_file", title: "Week 2 Reading" }),
    "material",
  );
});
