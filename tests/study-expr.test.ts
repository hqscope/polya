import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_EXPR_CHARS,
  MAX_NODES,
  evalExpression,
  evaluateExpr,
  expressionToLatex,
  parseExpr,
  toLatex,
} from "../supabase/functions/_shared/study-expr.ts";

function value(input: string): number {
  const result = evalExpression(input);
  if (!result.ok) assert.fail(`expected ${JSON.stringify(input)} to evaluate, got "${result.error}"`);
  return result.value;
}

function evalError(input: string): string {
  const result = evalExpression(input);
  if (result.ok) assert.fail(`expected ${JSON.stringify(input)} to fail, got ${result.value}`);
  return result.error;
}

function latex(input: string): string {
  const result = expressionToLatex(input);
  if (!result.ok) assert.fail(`expected ${JSON.stringify(input)} to print, got "${result.error}"`);
  return result.latex;
}

function close(actual: number, expected: number, tol: number): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} not within ${tol} of ${expected}`);
}

function closeRel(actual: number, expected: number, rel: number): void {
  assert.ok(
    Math.abs(actual - expected) <= rel * Math.abs(expected),
    `${actual} not within relative ${rel} of ${expected}`,
  );
}

const IMPLICIT = "Use * between numbers and names, like 2*pi.";
const PARENS = "Check the parentheses.";

test("basic arithmetic and precedence", () => {
  assert.equal(value("1 + 2 * 3"), 7);
  assert.equal(value("(1 + 2) * 3"), 9);
  assert.equal(value("10 - 4 - 3"), 3);
  assert.equal(value("12 / 3 / 2"), 2);
  assert.equal(value("2 ^ 3 ^ 2"), 512);
  close(value("1 - (5/6)^4"), 1 - Math.pow(5 / 6, 4), 1e-15);
  close(value("C(10,3) * 0.5^10"), 0.1171875, 1e-15);
});

test("unary minus, unary plus, and power", () => {
  assert.equal(value("-2^2"), -4);
  assert.equal(value("(-2)^2"), 4);
  assert.equal(value("2^-1"), 0.5);
  assert.equal(value("--2"), 2);
  assert.equal(value("+3"), 3);
  assert.equal(value("2 * -3"), -6);
  assert.equal(value("-(1+2)"), -3);
  assert.equal(value("1 - -1"), 2);
});

test("factorial binds tighter than power and unary minus", () => {
  assert.equal(value("3!^2"), 36);
  assert.equal(value("-3!"), -6);
  assert.equal(value("2^3!"), 64);
  assert.equal(value("3!!"), 720);
  assert.equal(value("(1+2)!"), 6);
  assert.equal(value("0!"), 1);
});

test("number formats", () => {
  assert.equal(value("12"), 12);
  assert.equal(value("0.5"), 0.5);
  assert.equal(value(".5"), 0.5);
  assert.equal(value("1.5e-3"), 0.0015);
  assert.equal(value("2E5"), 200000);
  assert.equal(value("1e+2"), 100);
  assert.equal(value("  7  "), 7);
  assert.equal(evalError("1.5.2"), "One of the numbers doesn't look right.");
  assert.equal(evalError("1e400"), "That number is too large to work with.");
});

test("unicode operators, ** and brackets", () => {
  assert.equal(value("2×3"), 6); // ×
  assert.equal(value("2·3"), 6); // ·
  assert.equal(value("2⋅3"), 6); // ⋅
  assert.equal(value("6÷2"), 3); // ÷
  assert.equal(value("5−2"), 3); // −
  assert.equal(value("5–2"), 3); // –
  assert.equal(value("2**3"), 8);
  assert.equal(value("2**3**2"), 512);
  assert.equal(value("[1+2]*3"), 9);
  assert.equal(value("[(1+2)*2]"), 6);
  assert.equal(evalError("[1+2)"), PARENS);
  assert.equal(evalError("(1+2]"), PARENS);
});

test("constants", () => {
  assert.equal(value("pi"), Math.PI);
  assert.equal(value("π"), Math.PI);
  assert.equal(value("e"), Math.E);
  assert.equal(value("2*pi"), 2 * Math.PI);
});

test("functions and aliases", () => {
  assert.equal(value("C(10,3)"), 120);
  assert.equal(value("choose(10,3)"), 120);
  assert.equal(value("binom(10,3)"), 120);
  assert.equal(value("C(5,0)"), 1);
  assert.equal(value("C(3,5)"), 0);
  assert.equal(value("perm(5,2)"), 20);
  assert.equal(value("perm(5,0)"), 1);
  assert.equal(value("perm(3,5)"), 0);
  assert.equal(value("fact(5)"), 120);
  close(value("exp(1)"), Math.E, 1e-15);
  close(value("ln(e)"), 1, 1e-15);
  close(value("log(e^2)"), 2, 1e-15);
  assert.equal(value("sqrt(16)"), 4);
  assert.equal(value("abs(-3)"), 3);
  assert.equal(value("C(10.0000000001, 3)"), 120);
});

test("aliases normalize in the tree", () => {
  const parsed = parseExpr("choose(5,2) + log(2) + fact(3)");
  if (!parsed.ok) assert.fail(parsed.error);
  assert.deepEqual(parsed.expr, {
    type: "bin",
    op: "+",
    left: {
      type: "bin",
      op: "+",
      left: {
        type: "call",
        name: "C",
        args: [
          { type: "num", value: 5, text: "5" },
          { type: "num", value: 2, text: "2" },
        ],
      },
      right: { type: "call", name: "ln", args: [{ type: "num", value: 2, text: "2" }] },
    },
    right: { type: "fact", arg: { type: "num", value: 3, text: "3" } },
  });
});

test("function arity and call errors", () => {
  assert.equal(evalError("C(10)"), "C takes 2 inputs, like C(10, 3).");
  assert.equal(evalError("binom(1,2,3)"), "binom takes 2 inputs, like binom(10, 3).");
  assert.equal(evalError("sqrt(1,2)"), "sqrt takes 1 input, like sqrt(2).");
  assert.equal(evalError("exp()"), "exp takes 1 input, like exp(2).");
  assert.equal(evalError("sum(k,0,3)"), "sum takes 4 inputs, like sum(k, 0, 3, k^2).");
  assert.equal(evalError("sum(k,0,3,k,1)"), "sum takes 4 inputs, like sum(k, 0, 3, k^2).");
  assert.equal(evalError("sqrt 4"), "Put the input to sqrt in parentheses, like sqrt(2).");
  assert.equal(evalError("C"), "Put the inputs to C in parentheses, like C(10, 3).");
  assert.equal(evalError("c(10,3)"), "Unknown name “c”.");
  assert.equal(evalError("C(10.5,3)"), "C needs whole numbers from 0 to 10000, like C(10, 3).");
  assert.equal(evalError("C(10001,1)"), "C needs whole numbers from 0 to 10000, like C(10, 3).");
  assert.equal(evalError("perm(-1,1)"), "perm needs whole numbers from 0 to 10000, like perm(10, 3).");
});

test("sum", () => {
  assert.equal(value("sum(k,0,3,k^2)"), 14);
  assert.equal(value("sum(k, 1, 4, k)"), 10);
  assert.equal(value("sum(k,3,2,k)"), 0); // empty range
  assert.equal(value("sum(i,1,3,sum(j,1,i,1))"), 6); // nested, inner bound uses outer var
  assert.equal(value("sum(k,1,2,sum(k,1,3,k))"), 12); // inner k shadows outer k
  assert.equal(value("sum(n, 0, 2, C(2,n))"), 4);
  close(value("sum(k,0,3,exp(-2)*2^k/k!)"), 0.8571234605, 1e-10);
  assert.equal(value("sum(k,0,999,1)"), 1000);
  assert.equal(evalError("sum(k,0,1000,1)"), "A sum can have at most 1000 terms.");
  assert.equal(evalError("sum(k,0,2.5,k)"), "The start and end of a sum must be whole numbers.");
  assert.equal(
    evalError("sum(2,0,3,k)"),
    "Start a sum with a single letter to count with, like sum(k, 0, 3, k^2).",
  );
  assert.equal(
    evalError("sum(e,0,3,1)"),
    "Start a sum with a single letter to count with, like sum(k, 0, 3, k^2).",
  );
});

test("a sum variable is unknown outside its sum", () => {
  assert.equal(evalError("k"), "Unknown name “k”.");
  assert.equal(evalError("sum(k,0,3,k) + k"), "Unknown name “k”.");
  assert.equal(evalError("sum(k,0,k,1)"), "Unknown name “k”.");
});

test("implicit multiplication is rejected", () => {
  for (const input of ["2pi", "3(4)", "2 e", "(1)(2)", "2 sqrt(4)", "pi(2)", "2 3", "3!4"]) {
    assert.equal(evalError(input), IMPLICIT, input);
  }
});

test("non-finite results are rejected", () => {
  assert.equal(evalError("1/0"), "You can't divide by zero.");
  assert.equal(evalError("0^-1"), "You can't divide by zero.");
  assert.equal(evalError("ln(0)"), "ln only works on positive numbers.");
  assert.equal(evalError("ln(-1)"), "ln only works on positive numbers.");
  assert.equal(evalError("sqrt(-1)"), "sqrt can't take a negative number.");
  assert.equal(evalError("exp(1000)"), "That number is too large to work with.");
  assert.equal(evalError("10^400"), "That number is too large to work with.");
  assert.equal(evalError("(-8)^(1/3)"), "That doesn't work out to a real number.");
  assert.equal(evalError("C(10000,5000)"), "That number is too large to work with.");
});

test("factorial bounds", () => {
  closeRel(value("170!"), 7.257415615307994e306, 1e-12);
  const factorialError = "Factorials only work on whole numbers from 0 to 170.";
  assert.equal(evalError("171!"), factorialError);
  assert.equal(evalError("2.5!"), factorialError);
  assert.equal(evalError("(-1)!"), factorialError);
  assert.equal(evalError("fact(-1)"), factorialError);
  // `-1!` reads as -(1!), the same rule that makes -3! = -6.
  assert.equal(value("-1!"), -1);
});

test("C(1000,500) stays finite and accurate", () => {
  closeRel(value("C(1000,500)"), 2.7028824094543656e299, 1e-9);
});

test("Phi", () => {
  close(value("Phi(0)"), 0.5, 1e-6);
  close(value("Phi(1.96)"), 0.9750021, 1e-6);
  closeRel(value("Phi(-5)"), 2.8665157e-7, 1e-5);
  close(value("Phi(1.5) + Phi(-1.5)"), 1, 1e-12);
});

test("hostile input: length, depth, node count", () => {
  assert.equal(
    evalError("1".repeat(MAX_EXPR_CHARS + 1)),
    `That's too long. Keep it under ${MAX_EXPR_CHARS} characters.`,
  );
  assert.equal(value("1".repeat(MAX_EXPR_CHARS)) > 1e299, true);

  const nested = (depth: number) => "(".repeat(depth) + "1" + ")".repeat(depth);
  assert.equal(value(nested(30)), 1);
  assert.equal(
    evalError(nested(40)),
    "That expression is nested too deeply. Try writing it more simply.",
  );
  assert.equal(
    evalError("-".repeat(40) + "1"),
    "That expression is nested too deeply. Try writing it more simply.",
  );

  // 1 + 1 + ... : n ones make 2n - 1 nodes.
  const ones = (count: number) => Array.from({ length: count }, () => "1").join("+");
  assert.equal(value(ones(100)), 100);
  assert.ok(2 * 101 - 1 > MAX_NODES);
  assert.equal(
    evalError(ones(101)),
    "That expression has too many parts. Try writing it more simply.",
  );
});

test("hostile input: evaluation budget returns quickly", () => {
  const started = Date.now();
  assert.equal(
    evalError("sum(k,1,1000,sum(j,1,1000,1))"),
    "That takes too long to work out. Try writing it more simply.",
  );
  // 1001 terms per sum is past the per-sum cap before any work starts.
  assert.equal(evalError("sum(k,0,1000,sum(j,0,1000,1))"), "A sum can have at most 1000 terms.");
  assert.ok(Date.now() - started < 1000);
});

test("hostile input: names, characters, stray punctuation", () => {
  assert.equal(evalError(""), "Enter a number or an expression.");
  assert.equal(evalError("   "), "Enter a number or an expression.");
  assert.equal(evalError("foo"), "Unknown name “foo”.");
  assert.equal(evalError("constructor(1)"), "Unknown name “constructor”.");
  assert.equal(evalError("toString"), "Unknown name “toString”.");
  assert.equal(
    evalError("a".repeat(40)),
    `Unknown name “${"a".repeat(20)}…”.`,
  );
  assert.equal(evalError(")"), PARENS);
  assert.equal(evalError("1+2)"), PARENS);
  assert.equal(evalError("(1+2"), PARENS);
  assert.equal(evalError("()"), PARENS);
  assert.equal(evalError(","), "There's a comma out of place.");
  assert.equal(evalError("1,2"), "There's a comma out of place.");
  assert.equal(evalError("(1,2)"), "There's a comma out of place.");
  const incomplete = "Something is missing. Check that every operator has a number on both sides.";
  assert.equal(evalError("1+"), incomplete);
  assert.equal(evalError("*2"), incomplete);
  assert.equal(evalError("2^"), incomplete);
  assert.equal(evalError("2***3"), incomplete);
  assert.equal(evalError("2 $ 3"), "The character “$” can't be used here.");
  assert.equal(evalError("alert`1`"), "The character “`” can't be used here.");
  assert.equal(evalError("1\u0000"), "That expression has a character that can't be used.");
  assert.equal(evalError("_x"), "The character “_” can't be used here.");
});

test("evaluateExpr on a tree never throws", () => {
  assert.deepEqual(evaluateExpr({ type: "var", name: "q" }), {
    ok: false,
    error: "Unknown name “q”.",
  });
  assert.deepEqual(evaluateExpr({ type: "neg", arg: { type: "num", value: 0, text: "0" } }), {
    ok: true,
    value: 0,
  });
});

test("toLatex", () => {
  assert.equal(latex("1 - (5/6)^4"), "1 - \\left(\\frac{5}{6}\\right)^{4}");
  assert.equal(latex("C(10,3) * 0.5^10"), "\\binom{10}{3} \\cdot {0.5}^{10}");
  assert.equal(latex("(-2)^2"), "\\left(-2\\right)^{2}");
  assert.equal(latex("-2^2"), "-{2}^{2}");
  assert.equal(latex("-(1+2)"), "-\\left(1 + 2\\right)");
  assert.equal(latex("2^-1"), "{2}^{-1}");
  assert.equal(latex("exp(-2)"), "e^{-2}");
  assert.equal(latex("ln(2)"), "\\ln\\left(2\\right)");
  assert.equal(latex("log(2)"), "\\ln\\left(2\\right)");
  assert.equal(latex("sqrt(2)"), "\\sqrt{2}");
  assert.equal(latex("abs(-3)"), "\\left|-3\\right|");
  assert.equal(latex("Phi(1.96)"), "\\Phi\\left(1.96\\right)");
  assert.equal(latex("perm(5,2)"), "P(5, 2)");
  assert.equal(latex("binom(5,2)"), "\\binom{5}{2}");
  assert.equal(latex("fact(5)"), "5!");
  assert.equal(latex("(1+2)!"), "\\left(1 + 2\\right)!");
  assert.equal(latex("3!^2"), "\\left(3!\\right)^{2}");
  assert.equal(latex("sum(k,0,3,k^2)"), "\\sum_{k=0}^{3} {k}^{2}");
  assert.equal(latex("sum(k,0,3,k+1)"), "\\sum_{k=0}^{3} \\left(k + 1\\right)");
  assert.equal(
    latex("sum(k,0,3,exp(-2)*2^k/k!)"),
    "\\sum_{k=0}^{3} \\frac{e^{-2} \\cdot {2}^{k}}{k!}",
  );
  assert.equal(latex("1-(2-3)"), "1 - \\left(2 - 3\\right)");
  assert.equal(latex("1+(2-3)"), "1 + 2 - 3");
  assert.equal(latex("(1+2)*(3+4)"), "\\left(1 + 2\\right) \\cdot \\left(3 + 4\\right)");
  assert.equal(latex("1/(2+3)"), "\\frac{1}{2 + 3}");
  assert.equal(latex("2*-3"), "2 \\cdot \\left(-3\\right)");
  assert.equal(latex("pi * e"), "\\pi \\cdot e");
  assert.equal(latex("1.5e-3"), "1.5 \\times 10^{-3}");
  assert.equal(latex(".5"), ".5");
  assert.equal(latex("exp(1)^2"), "\\left(e^{1}\\right)^{2}");
});

test("expressionToLatex reports parse errors", () => {
  assert.deepEqual(expressionToLatex("2pi"), { ok: false, error: IMPLICIT });
  const parsed = parseExpr("1/(2+3)");
  if (!parsed.ok) assert.fail(parsed.error);
  assert.equal(toLatex(parsed.expr), "\\frac{1}{2 + 3}");
});
