import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ABS_TOL,
  REL_TOL,
  gradeAttempt,
  gradePart,
  withinTolerance,
  type PartKey,
  type PartResponse,
  type PartResult,
} from "../supabase/functions/_shared/study-grade.ts";

const numericKey = (expr: string, value: number): PartKey => ({ kind: "numeric", expr, value });
const numeric = (answer: string): PartResponse => ({ kind: "numeric", answer });
const mc = (choice: number): PartResponse => ({ kind: "mc", choice });
const selectAll = (choices: number[]): PartResponse => ({ kind: "select_all", choices });

function correctness(result: PartResult): boolean {
  if (!result.ok) assert.fail(`expected a graded result, got "${result.message}"`);
  return result.correct;
}

test("tolerance defaults", () => {
  assert.equal(REL_TOL, 1e-2);
  assert.equal(ABS_TOL, 1e-6);
});

test("withinTolerance: relative boundary", () => {
  assert.equal(withinTolerance(101, 100), true); // exactly 1% away
  assert.equal(withinTolerance(99, 100), true);
  assert.equal(withinTolerance(101.0001, 100), false);
  assert.equal(withinTolerance(98.9999, 100), false);
  assert.equal(withinTolerance(-101, -100), true);
  assert.equal(withinTolerance(-101.0001, -100), false);
});

test("withinTolerance: key 0 uses the absolute tolerance", () => {
  assert.equal(withinTolerance(0, 0), true);
  assert.equal(withinTolerance(1e-6, 0), true);
  assert.equal(withinTolerance(-1e-6, 0), true);
  assert.equal(withinTolerance(1.1e-6, 0), false);
});

test("withinTolerance: custom tolerances and non-finite values", () => {
  assert.equal(withinTolerance(1.05, 1, 0.1), true);
  assert.equal(withinTolerance(0.5, 0, 0, 0.5), true);
  assert.equal(withinTolerance(Number.NaN, 1), false);
  assert.equal(withinTolerance(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY), false);
});

test("numeric: any equivalent expression is graded by value", () => {
  const key = numericKey("C(5,3) * 0.5^5", 0.3125);
  for (const answer of ["C(5,3)*0.5^5", "10/32", "0.3125", " 5/16 ", "0.31"]) {
    assert.equal(correctness(gradePart(key, numeric(answer))), true, answer);
  }
  assert.equal(correctness(gradePart(key, numeric("0.3"))), false);

  const result = gradePart(numericKey("19/32", 19 / 32), numeric("19/32"));
  assert.deepEqual(result, { ok: true, correct: true, value: 0.59375 });
});

test("numeric: unreadable answers are bad_answer with the evaluator's message", () => {
  const key = numericKey("1/2", 0.5);
  assert.deepEqual(gradePart(key, numeric("2pi")), {
    ok: false,
    code: "bad_answer",
    message: "Use * between numbers and names, like 2*pi.",
  });
  assert.deepEqual(gradePart(key, numeric("   ")), {
    ok: false,
    code: "bad_answer",
    message: "Enter a number or an expression.",
  });
  assert.deepEqual(gradePart(key, numeric("50%")), {
    ok: false,
    code: "bad_answer",
    message: "The character “%” can't be used here.",
  });
  const tooLong = gradePart(key, numeric("1".repeat(301)));
  assert.equal(tooLong.ok, false);
});

test("kind mismatch is bad_answer", () => {
  const result = gradePart({ kind: "mc", correct: 1 }, numeric("1"));
  assert.deepEqual(result, {
    ok: false,
    code: "bad_answer",
    message: "That answer doesn't fit this question.",
  });
  assert.equal(gradePart(numericKey("1", 1), mc(1)).ok, false);
  assert.equal(gradePart({ kind: "select_all", correct: [1] }, mc(1)).ok, false);
});

test("mc: right, wrong, and invalid choices", () => {
  const key: PartKey = { kind: "mc", correct: 2 };
  assert.deepEqual(gradePart(key, mc(2)), { ok: true, correct: true });
  assert.deepEqual(gradePart(key, mc(0)), { ok: true, correct: false });
  assert.deepEqual(gradePart(key, mc(99)), { ok: true, correct: false });
  for (const bad of [-1, 1.5, Number.NaN]) {
    assert.deepEqual(gradePart(key, mc(bad)), {
      ok: false,
      code: "bad_answer",
      message: "Pick one of the choices.",
    });
  }
});

test("select_all: exact set match", () => {
  const key: PartKey = { kind: "select_all", correct: [0, 2, 3] };
  assert.equal(correctness(gradePart(key, selectAll([0, 2, 3]))), true);
  assert.equal(correctness(gradePart(key, selectAll([3, 0, 2]))), true); // order-insensitive
  assert.equal(correctness(gradePart(key, selectAll([0, 2, 2, 3, 0]))), true); // duplicates
  assert.equal(correctness(gradePart(key, selectAll([0, 2]))), false); // missing one
  assert.equal(correctness(gradePart(key, selectAll([0, 1, 2, 3]))), false); // extra one
  assert.equal(correctness(gradePart(key, selectAll([]))), false);
});

test("select_all: empty set against an empty key is correct", () => {
  assert.equal(correctness(gradePart({ kind: "select_all", correct: [] }, selectAll([]))), true);
  assert.equal(correctness(gradePart({ kind: "select_all", correct: [] }, selectAll([1]))), false);
});

test("select_all: non-integer choices are bad_answer", () => {
  const key: PartKey = { kind: "select_all", correct: [1] };
  for (const choices of [[1.5], [1, -1], [Number.NaN]]) {
    assert.deepEqual(gradePart(key, selectAll(choices)), {
      ok: false,
      code: "bad_answer",
      message: "Pick from the listed choices.",
    });
  }
});

test("gradeAttempt: score and allCorrect", () => {
  const keys: PartKey[] = [
    numericKey("1/2", 0.5),
    { kind: "mc", correct: 1 },
    { kind: "select_all", correct: [0, 1] },
    numericKey("C(4,2)", 6),
  ];

  const allRight = gradeAttempt(keys, [numeric("0.5"), mc(1), selectAll([1, 0]), numeric("C(4,2)")]);
  if (!allRight.ok) assert.fail(allRight.message);
  assert.equal(allRight.grade.score, 1);
  assert.equal(allRight.grade.allCorrect, true);
  assert.equal(allRight.grade.results.length, 4);

  const halfRight = gradeAttempt(keys, [numeric("0.5"), mc(0), selectAll([0]), numeric("6")]);
  if (!halfRight.ok) assert.fail(halfRight.message);
  assert.equal(halfRight.grade.score, 0.5);
  assert.equal(halfRight.grade.allCorrect, false);
  assert.deepEqual(halfRight.grade.results[0], { ok: true, correct: true, value: 0.5 });
  assert.deepEqual(halfRight.grade.results[1], { ok: true, correct: false });
});

test("gradeAttempt: the first bad answer stops grading", () => {
  const keys: PartKey[] = [numericKey("1", 1), { kind: "mc", correct: 0 }, numericKey("2", 2)];
  const result = gradeAttempt(keys, [numeric("1"), mc(1), numeric("2pi")]);
  assert.deepEqual(result, {
    ok: false,
    code: "bad_answer",
    partIndex: 2,
    message: "Use * between numbers and names, like 2*pi.",
  });

  const twoBad = gradeAttempt(keys, [numeric("1"), numeric("0"), numeric("oops")]);
  if (twoBad.ok) assert.fail("expected bad_answer");
  assert.equal(twoBad.partIndex, 1);
});

test("gradeAttempt: response count must match", () => {
  const keys: PartKey[] = [numericKey("1", 1), numericKey("2", 2)];
  const tooFew = gradeAttempt(keys, [numeric("1")]);
  if (tooFew.ok) assert.fail("expected bad_answer");
  assert.equal(tooFew.code, "bad_answer");
  assert.equal(tooFew.partIndex, 1);

  const tooMany = gradeAttempt(keys, [numeric("1"), numeric("2"), numeric("3")]);
  if (tooMany.ok) assert.fail("expected bad_answer");
  assert.equal(tooMany.partIndex, 2);
});

test("gradeAttempt: no parts scores 0 and is not allCorrect", () => {
  const result = gradeAttempt([], []);
  if (!result.ok) assert.fail(result.message);
  assert.equal(result.grade.score, 0);
  assert.equal(result.grade.allCorrect, false);
});
