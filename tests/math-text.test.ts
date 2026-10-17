import { test } from "node:test";
import assert from "node:assert/strict";

import { hasMath, mathRanges, openMathStart, splitMath } from "../src/lib/math-text.ts";

const shape = (text: string) =>
  splitMath(text).map((s) => (s.kind === "math" ? `${s.display ? "D" : "I"}:${s.tex}` : s.text));

test("inline and display delimiters split out math runs", () => {
  assert.deepEqual(shape("So \\(E[X] = np\\) and \\[\\operatorname{Var}(X) = np(1-p)\\] [2]."), [
    "So ",
    "I:E[X] = np",
    " and ",
    "D:\\operatorname{Var}(X) = np(1-p)",
    " [2].",
  ]);
  assert.deepEqual(shape("$$\\binom{10}{3}$$"), ["D:\\binom{10}{3}"]);
});

test("a single $ is money, not math", () => {
  assert.deepEqual(shape("You win $5 with probability 1/2, and lose $3 otherwise."), [
    "You win $5 with probability 1/2, and lose $3 otherwise.",
  ]);
  assert.equal(hasMath("costs $5 and $6"), false);
});

test("an unclosed opener stays text (mid-stream answers)", () => {
  assert.deepEqual(shape("Start \\(x^2 + "), ["Start \\(x^2 + "]);
  assert.deepEqual(shape("\\(a\\) then \\[b"), ["I:a", " then \\[b"]);
});

test("empty math is left alone; citations stay outside math", () => {
  assert.deepEqual(shape("odd \\(\\) case"), ["odd \\(\\) case"]);
  assert.deepEqual(shape("\\(x_{[1]}\\) is the minimum [1]"), ["I:x_{[1]}", " is the minimum [1]"]);
});

test("plain prose passes through as one run", () => {
  assert.deepEqual(splitMath("No math here."), [{ kind: "text", text: "No math here." }]);
  assert.deepEqual(splitMath(""), []);
  assert.equal(hasMath("\\(p\\)"), true);
});

test("mathRanges reports offsets that include the delimiters", () => {
  const text = "a \\(x\\) b $$y$$";
  const ranges = mathRanges(text);
  assert.deepEqual(ranges, [
    { start: 2, end: 7, tex: "x", display: false },
    { start: 10, end: 15, tex: "y", display: true },
  ]);
  for (const range of ranges) {
    const raw = text.slice(range.start, range.end);
    assert.ok(raw.startsWith("\\(") || raw.startsWith("$$"));
  }
  assert.deepEqual(mathRanges("odd \\(\\) case"), []);
});

test("openMathStart finds a display opener still waiting for its closer", () => {
  assert.equal(openMathStart("done \\[x\\] then \\[y = "), 16);
  assert.equal(openMathStart("cost $$12"), 5);
  // Inline openers and complete runs don't count.
  assert.equal(openMathStart("start \\(x + "), -1);
  assert.equal(openMathStart("\\[x\\]"), -1);
  assert.equal(openMathStart("win $5"), -1);
});
