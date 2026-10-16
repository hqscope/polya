import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkAgreement,
  parseCheckerOutput,
  parseResponses,
  parseTopicsOutput,
  parseWriterOutput,
  prepareQuestion,
  questionForChecker,
  stripInvalidCitations,
  type WriterQuestion,
} from "../supabase/functions/_shared/study-questions.ts";
import { suggestExamFileKind } from "../supabase/functions/_shared/study-files.ts";

// A fixed "random" so shuffles are reproducible: always swap with index 0.
const noShuffle = () => 0.999999;

function numericQ(answer_expr: string): WriterQuestion {
  return {
    stem: "A fair die is rolled 4 times.",
    parts: [{ kind: "numeric", prompt: "P(at least one six)?", answer_expr, options: [] }],
    explanation: "Complement rule [1]: \\(1 - (5/6)^4\\). See also [9].",
  };
}

function mcQ(options: { expr: string; correct: boolean }[], answer_expr: string): WriterQuestion {
  return {
    stem: "Bayes.",
    parts: [
      {
        kind: "mc",
        prompt: "P(R | voted)?",
        answer_expr,
        options: options.map((o) => ({ ...o, text: "" })),
      },
    ],
    explanation: "Bayes' rule [2].",
  };
}

test("a numeric part keeps its expression and evaluated value; bad citations go", () => {
  const result = prepareQuestion(numericQ("1 - (5/6)^4"), 3, noShuffle);
  assert.ok(result.ok);
  assert.deepEqual(result.question.parts, [{ kind: "numeric", prompt: "P(at least one six)?" }]);
  assert.equal(result.question.keys[0]!.kind, "numeric");
  const key = result.question.keys[0] as { kind: "numeric"; value: number; expr: string };
  assert.ok(Math.abs(key.value - 0.5177469) < 1e-6);
  assert.equal(result.question.explanation, "Complement rule [1]: \\(1 - (5/6)^4\\). See also.");
});

test("a numeric part whose answer doesn't evaluate is dropped", () => {
  const result = prepareQuestion(numericQ("about 0.52"), 3);
  assert.equal(result.ok, false);
});

test("value options: the computed answer picks the key, rendered from the checked expression", () => {
  const q = mcQ(
    [
      { expr: "0.2*0.1/0.18", correct: false },
      { expr: "0.2*0.1/(0.45*0.25+0.25*0.2+0.2*0.1)", correct: true },
      { expr: "0.1", correct: false },
    ],
    "0.02/0.1825",
  );
  const result = prepareQuestion(q, 3, noShuffle);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  const part = result.question.parts[0]!;
  assert.equal(part.kind, "mc");
  assert.ok(part.kind === "mc" && part.options.every((o) => o.startsWith("\\(") && o.endsWith("\\)")));
  const key = result.question.keys[0]!;
  assert.equal(key.kind, "mc");
  // The keyed option shows the expression that evaluates to the answer.
  assert.ok(key.kind === "mc" && part.kind === "mc" && part.options[key.correct]!.includes("0.45"));
});

test("value options are refused when the key is ambiguous, absent, or mismarked", () => {
  const same = mcQ(
    [
      { expr: "1/2", correct: true },
      { expr: "2/4", correct: false },
    ],
    "0.5",
  );
  assert.equal(prepareQuestion(same, 1).ok, false, "two options with one value");

  const none = mcQ(
    [
      { expr: "0.3", correct: true },
      { expr: "0.4", correct: false },
    ],
    "0.5",
  );
  assert.equal(prepareQuestion(none, 1).ok, false, "no option equals the answer");

  const mismarked = mcQ(
    [
      { expr: "0.5", correct: false },
      { expr: "0.4", correct: true },
    ],
    "1/2",
  );
  assert.equal(prepareQuestion(mismarked, 1).ok, false, "flag disagrees with the computed answer");
});

test("statement options: exactly one correct for mc, at least one for select-all", () => {
  const tf: WriterQuestion = {
    stem: "Coin tosses.",
    parts: [
      {
        kind: "mc",
        prompt: "The events are mutually independent.",
        answer_expr: "",
        options: [
          { expr: "", text: "True", correct: false },
          { expr: "", text: "False", correct: true },
        ],
      },
      {
        kind: "select_all",
        prompt: "Which hold?",
        answer_expr: "",
        options: [
          { expr: "", text: "A and B are disjoint", correct: true },
          { expr: "", text: "A and B are independent", correct: false },
          { expr: "", text: "\\(P(A) = 1/4\\)", correct: true },
        ],
      },
    ],
    explanation: "Because [1].",
  };
  const result = prepareQuestion(tf, 1, noShuffle);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  // True/False stays in the order written.
  assert.deepEqual(result.question.parts[0], { kind: "mc", prompt: tf.parts[0]!.prompt, options: ["True", "False"] });
  assert.deepEqual(result.question.keys[0], { kind: "mc", correct: 1 });
  const key = result.question.keys[1]!;
  assert.equal(key.kind, "select_all");
  const part = result.question.parts[1]!;
  assert.ok(key.kind === "select_all" && part.kind === "select_all");
  assert.deepEqual(
    key.correct.map((i) => part.options[i]).sort(),
    ["A and B are disjoint", "\\(P(A) = 1/4\\)"].sort(),
  );

  const twoRight = structuredClone(tf);
  twoRight.parts[0]!.options[0]!.correct = true;
  assert.equal(prepareQuestion(twoRight, 1).ok, false);
  const noneRight = structuredClone(tf);
  noneRight.parts[1]!.options.forEach((o) => (o.correct = false));
  assert.equal(prepareQuestion(noneRight, 1).ok, false);
});

test("shuffling moves the key with its option", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let round = 0; round < 20; round++) {
    const q = mcQ(
      [
        { expr: "0.1", correct: false },
        { expr: "0.2", correct: false },
        { expr: "0.3", correct: true },
        { expr: "0.4", correct: false },
      ],
      "3/10",
    );
    const result = prepareQuestion(q, 1, random);
    assert.ok(result.ok);
    const part = result.question.parts[0]!;
    const key = result.question.keys[0]!;
    assert.ok(part.kind === "mc" && key.kind === "mc");
    assert.equal(part.options[key.correct], "\\(0.3\\)");
  }
});

test("structural limits: parts, options, empty text", () => {
  const tooMany = numericQ("1");
  tooMany.parts = Array.from({ length: 5 }, () => ({ kind: "numeric" as const, prompt: "x", answer_expr: "1", options: [] }));
  assert.equal(prepareQuestion(tooMany, 1).ok, false);
  assert.equal(prepareQuestion({ ...numericQ("1"), stem: "  " }, 1).ok, false);
  assert.equal(prepareQuestion({ ...numericQ("1"), explanation: "[4]" }, 1).ok, false, "only an invalid citation");
  const oneOption = mcQ([{ expr: "1", correct: true }], "1");
  assert.equal(prepareQuestion(oneOption, 1).ok, false);
});

test("the checker must reach the same answers without seeing the key", () => {
  const prepared = prepareQuestion(numericQ("1 - (5/6)^4"), 3);
  assert.ok(prepared.ok);
  const keys = prepared.question.keys;
  assert.deepEqual(checkAgreement(keys, { problem: "", parts: [{ answer_expr: "1-625/1296", choices: [] }] }), {
    agree: true,
  });
  assert.equal(checkAgreement(keys, { problem: "", parts: [{ answer_expr: "625/1296", choices: [] }] }).agree, false);
  assert.equal(checkAgreement(keys, { problem: "Ambiguous: die not said to be fair", parts: [{ answer_expr: "1-625/1296", choices: [] }] }).agree, false);
  assert.equal(checkAgreement(keys, undefined).agree, false);
  assert.equal(checkAgreement(keys, { problem: "", parts: [] }).agree, false);

  assert.deepEqual(checkAgreement([{ kind: "mc", correct: 2 }], { problem: "", parts: [{ answer_expr: "", choices: ["C"] }] }), {
    agree: true,
  });
  assert.equal(checkAgreement([{ kind: "mc", correct: 2 }], { problem: "", parts: [{ answer_expr: "", choices: ["B"] }] }).agree, false);
  assert.deepEqual(
    checkAgreement([{ kind: "select_all", correct: [0, 2] }], { problem: "", parts: [{ answer_expr: "", choices: ["C", "A"] }] }),
    { agree: true },
  );
  assert.equal(
    checkAgreement([{ kind: "select_all", correct: [0, 2] }], { problem: "", parts: [{ answer_expr: "", choices: ["A"] }] }).agree,
    false,
  );
});

test("the checker sees lettered options and no key", () => {
  const text = questionForChecker(0, {
    stem: "Stem",
    parts: [
      { kind: "numeric", prompt: "How many?" },
      { kind: "select_all", prompt: "Which?", options: ["one", "two"] },
    ],
  });
  assert.equal(
    text,
    "QUESTION 1\nStem\nPart 1 (numeric answer): How many?\nPart 2 (select all that apply): Which?\n  A. one\n  B. two",
  );
});

test("output parsers reject anything off-shape", () => {
  assert.equal(parseWriterOutput({ questions: [{ stem: "s", parts: [{ kind: "essay" }], explanation: "" }] }), null);
  assert.equal(parseWriterOutput(null), null);
  assert.equal(parseWriterOutput({ questions: [] })!.length, 0);
  assert.equal(parseCheckerOutput({ answers: [{ problem: "", parts: [{ answer_expr: "1", choices: [3] }] }] }), null);
  assert.equal(parseCheckerOutput({ answers: [{ problem: "", parts: [{ answer_expr: "1", choices: [] }] }] })!.length, 1);
});

test("citations outside the evidence are removed", () => {
  assert.equal(stripInvalidCitations("Use [1] and [2], not [0] or [12].", 2), "Use [1] and [2], not or.");
});

test("topic suggestions are cleaned, deduplicated, and file numbers mapped", () => {
  const topics = parseTopicsOutput(
    {
      topics: [
        { title: "  Indicators ", summary: "Use indicators.", key_formulas: ["E[X] = \\sum_i P(A_i)", "$x$"], source_refs: [1, 3, 3, 9, 0] },
        { title: "indicators", summary: "dup", key_formulas: [], source_refs: [] },
        { title: "Variance", summary: "Var.", key_formulas: [], source_refs: [2] },
        { title: "Poisson", summary: "Rates.", key_formulas: [], source_refs: [] },
      ],
    },
    3,
  );
  assert.ok(topics);
  assert.equal(topics.length, 3);
  assert.deepEqual(topics[0], {
    title: "Indicators",
    summary: "Use indicators.",
    key_formulas: ["E[X] = \\sum_i P(A_i)", "x"],
    source_indexes: [0, 2],
  });
  assert.equal(parseTopicsOutput({ topics: [{ title: "one", summary: "", key_formulas: [], source_refs: [] }] }, 1), null);
});

test("file names suggest formula sheets and past exams", () => {
  assert.equal(suggestExamFileKind("Quiz3-formulas"), "formula_sheet");
  assert.equal(suggestExamFileKind("Final cheat sheet"), "formula_sheet");
  assert.equal(suggestExamFileKind("F26_Stat_134_midterm-practice1-brief-soln"), "past_exam");
  assert.equal(suggestExamFileKind("fa25_mt2_sol"), "past_exam");
  assert.equal(suggestExamFileKind("Practice Quiz 1"), "past_exam");
  assert.equal(suggestExamFileKind("Lec13-stat134-Fall26"), null);
  assert.equal(suggestExamFileKind("Ch4MGFWorksheet"), null);
  assert.equal(suggestExamFileKind(null), null);
});

test("submitted answers are read strictly", () => {
  assert.deepEqual(
    parseResponses([
      { kind: "numeric", answer: "C(10,3)*0.5^10" },
      { kind: "mc", choice: 2 },
      { kind: "select_all", choices: [0, 3] },
    ]),
    [
      { kind: "numeric", answer: "C(10,3)*0.5^10" },
      { kind: "mc", choice: 2 },
      { kind: "select_all", choices: [0, 3] },
    ],
  );
  for (const bad of [null, [], [{ kind: "mc", choice: "2" }], [{ kind: "numeric", answer: 5 }], [{ kind: "essay" }],
    [{ kind: "select_all", choices: [0.5] }], [{ kind: "numeric", answer: "x".repeat(301) }],
    Array.from({ length: 5 }, () => ({ kind: "mc", choice: 0 }))]) {
    assert.equal(parseResponses(bad), null, JSON.stringify(bad).slice(0, 60));
  }
});
