// Practice-question math: a safe parser, evaluator, and LaTeX printer for
// arithmetic expressions such as `1 - (5/6)^4` or `C(10,3) * 0.5^10`.
// Answer keys (model-written) and student answers both pass through here, so
// input is untrusted: no eval/Function, and hard caps on length, nesting, node
// count, and evaluation work. Error strings are shown to students, so they
// describe the math, never the machinery.
// Pure module: no runtime globals.

export const MAX_EXPR_CHARS = 300;
export const MAX_DEPTH = 32;
export const MAX_NODES = 200;
export const MAX_EVAL_STEPS = 200000;
export const MAX_SUM_TERMS = 1000;
export const MAX_FACTORIAL_ARG = 170;
export const MAX_CHOOSE_ARG = 10000;

// Values within this distance of a whole number count as that whole number.
const INT_TOL = 1e-9;

export type CanonicalFn = "C" | "perm" | "exp" | "ln" | "sqrt" | "abs" | "Phi";
export type BinOp = "+" | "-" | "*" | "/" | "^";

export type Expr =
  | { type: "num"; value: number; text: string }
  | { type: "const"; name: "pi" | "e" }
  | { type: "var"; name: string }
  | { type: "neg"; arg: Expr }
  | { type: "bin"; op: BinOp; left: Expr; right: Expr }
  | { type: "fact"; arg: Expr }
  | { type: "call"; name: CanonicalFn; args: Expr[] }
  | { type: "sum"; var: string; lo: Expr; hi: Expr; body: Expr };

export type ParseResult = { ok: true; expr: Expr } | { ok: false; error: string };
export type EvalResult = { ok: true; value: number } | { ok: false; error: string };
export type LatexResult = { ok: true; latex: string } | { ok: false; error: string };

const MSG = {
  empty: "Enter a number or an expression.",
  tooLong: `That's too long. Keep it under ${MAX_EXPR_CHARS} characters.`,
  tooManyParts: "That expression has too many parts. Try writing it more simply.",
  tooDeep: "That expression is nested too deeply. Try writing it more simply.",
  parens: "Check the parentheses.",
  comma: "There's a comma out of place.",
  incomplete: "Something is missing. Check that every operator has a number on both sides.",
  implicit: "Use * between numbers and names, like 2*pi.",
  badNumber: "One of the numbers doesn't look right.",
  badChar: "That expression has a character that can't be used.",
  divZero: "You can't divide by zero.",
  tooLarge: "That number is too large to work with.",
  notReal: "That doesn't work out to a real number.",
  ln: "ln only works on positive numbers.",
  sqrt: "sqrt can't take a negative number.",
  factorial: `Factorials only work on whole numbers from 0 to ${MAX_FACTORIAL_ARG}.`,
  sumVar: "Start a sum with a single letter to count with, like sum(k, 0, 3, k^2).",
  sumBounds: "The start and end of a sum must be whole numbers.",
  sumTerms: `A sum can have at most ${MAX_SUM_TERMS} terms.`,
  work: "That takes too long to work out. Try writing it more simply.",
  generic: "That expression couldn't be worked out.",
};

class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

function fail(message: string): never {
  throw new ExprError(message);
}

function messageOf(error: unknown): string {
  return error instanceof ExprError ? error.message : MSG.generic;
}

// ---------------------------------------------------------------------------
// Tokens

type OpChar = "+" | "-" | "*" | "/" | "^" | "!";

type Token =
  | { kind: "num"; value: number; text: string }
  | { kind: "name"; text: string }
  | { kind: "op"; op: OpChar }
  | { kind: "open"; closer: ")" | "]" }
  | { kind: "close"; char: ")" | "]" }
  | { kind: "comma" }
  | { kind: "end" };

const END: Token = { kind: "end" };

// Unicode operators students paste from notes or keyboards: × · ⋅ ÷ − –
const OPS = new Map<string, OpChar>([
  ["+", "+"],
  ["-", "-"],
  ["−", "-"],
  ["–", "-"],
  ["*", "*"],
  ["×", "*"],
  ["·", "*"],
  ["⋅", "*"],
  ["/", "/"],
  ["÷", "/"],
  ["^", "^"],
  ["!", "!"],
]);

const NUMBER_RE = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const NUMBER_FULL_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const NAME_RE = /[A-Za-z][A-Za-z0-9_]*/y;
const WHITESPACE_RE = /\s/;

function unexpectedChar(input: string, index: number): string {
  const code = input.codePointAt(index) ?? 0;
  if (code < 0x21 || (code >= 0x7f && code <= 0x9f)) return MSG.badChar;
  return `The character “${String.fromCodePoint(code)}” can't be used here.`;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (WHITESPACE_RE.test(ch)) {
      i++;
      continue;
    }
    if (ch === "*" && input[i + 1] === "*") {
      tokens.push({ kind: "op", op: "^" });
      i += 2;
      continue;
    }
    const op = OPS.get(ch);
    if (op) {
      tokens.push({ kind: "op", op });
      i++;
      continue;
    }
    if (ch === "(" || ch === "[") {
      tokens.push({ kind: "open", closer: ch === "(" ? ")" : "]" });
      i++;
      continue;
    }
    if (ch === ")" || ch === "]") {
      tokens.push({ kind: "close", char: ch });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma" });
      i++;
      continue;
    }
    if (ch === "π") {
      tokens.push({ kind: "name", text: "pi" });
      i++;
      continue;
    }

    NUMBER_RE.lastIndex = i;
    const num = NUMBER_RE.exec(input);
    if (num) {
      const text = num[0];
      i += text.length;
      // "1.5.2" or "1e5.2": a second decimal point means a malformed number.
      if (input[i] === ".") fail(MSG.badNumber);
      const value = Number(text);
      if (!Number.isFinite(value)) fail(MSG.tooLarge);
      tokens.push({ kind: "num", value, text });
      continue;
    }

    NAME_RE.lastIndex = i;
    const name = NAME_RE.exec(input);
    if (name) {
      tokens.push({ kind: "name", text: name[0] });
      i += name[0].length;
      continue;
    }

    fail(unexpectedChar(input, i));
  }
  tokens.push(END);
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent)
//
//   expression := term (("+" | "-") term)*
//   term       := unary (("*" | "/") unary)*
//   unary      := ("-" | "+") unary | power
//   power      := postfix ("^" unary)?          right-associative via unary
//   postfix    := primary "!"*
//   primary    := number | name | name "(" args ")" | "(" expression ")"

interface FnSpec {
  canonical: CanonicalFn | "fact" | "sum";
  arity: number;
  example: string;
}

// A Map, not an object literal, so names like "constructor" or "toString"
// never resolve to inherited properties.
const FUNCTIONS = new Map<string, FnSpec>([
  ["C", { canonical: "C", arity: 2, example: "C(10, 3)" }],
  ["choose", { canonical: "C", arity: 2, example: "choose(10, 3)" }],
  ["binom", { canonical: "C", arity: 2, example: "binom(10, 3)" }],
  ["perm", { canonical: "perm", arity: 2, example: "perm(5, 2)" }],
  ["fact", { canonical: "fact", arity: 1, example: "fact(5)" }],
  ["exp", { canonical: "exp", arity: 1, example: "exp(2)" }],
  ["ln", { canonical: "ln", arity: 1, example: "ln(2)" }],
  ["log", { canonical: "ln", arity: 1, example: "log(2)" }],
  ["sqrt", { canonical: "sqrt", arity: 1, example: "sqrt(2)" }],
  ["abs", { canonical: "abs", arity: 1, example: "abs(-3)" }],
  ["Phi", { canonical: "Phi", arity: 1, example: "Phi(1.96)" }],
  ["sum", { canonical: "sum", arity: 4, example: "sum(k, 0, 3, k^2)" }],
]);

const CALL_ARITY: Record<CanonicalFn, number> = {
  C: 2,
  perm: 2,
  exp: 1,
  ln: 1,
  sqrt: 1,
  abs: 1,
  Phi: 1,
};

const SUM_VARS = new Set(["i", "j", "k", "m", "n", "x", "y"]);

function clipName(name: string): string {
  return name.length > 20 ? `${name.slice(0, 20)}…` : name;
}

function plural(count: number, word: string): string {
  return count === 1 ? `${count} ${word}` : `${count} ${word}s`;
}

function parseTokens(tokens: Token[]): Expr {
  let pos = 0;
  let depth = 0;
  let nodes = 0;
  const scope: string[] = [];

  const peek = (): Token => tokens[pos] ?? END;
  const next = (): Token => tokens[pos++] ?? END;

  function node(expr: Expr): Expr {
    nodes++;
    if (nodes > MAX_NODES) fail(MSG.tooManyParts);
    return expr;
  }

  function enter(): void {
    depth++;
    if (depth > MAX_DEPTH) fail(MSG.tooDeep);
  }

  function startsOperand(t: Token): boolean {
    return t.kind === "num" || t.kind === "name" || t.kind === "open";
  }

  function parseExpression(): Expr {
    enter();
    let left = parseTerm();
    for (;;) {
      const t = peek();
      if (t.kind !== "op" || (t.op !== "+" && t.op !== "-")) break;
      pos++;
      const right = parseTerm();
      left = node({ type: "bin", op: t.op, left, right });
    }
    depth--;
    return left;
  }

  function parseTerm(): Expr {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t.kind === "op" && (t.op === "*" || t.op === "/")) {
        pos++;
        const right = parseUnary();
        left = node({ type: "bin", op: t.op, left, right });
      } else if (startsOperand(t)) {
        fail(MSG.implicit);
      } else {
        break;
      }
    }
    return left;
  }

  function parseUnary(): Expr {
    const t = peek();
    if (t.kind === "op" && (t.op === "-" || t.op === "+")) {
      pos++;
      enter();
      const arg = parseUnary();
      depth--;
      return t.op === "-" ? node({ type: "neg", arg }) : arg;
    }
    return parsePower();
  }

  function parsePower(): Expr {
    const base = parsePostfix();
    const t = peek();
    if (t.kind !== "op" || t.op !== "^") return base;
    pos++;
    enter();
    // Exponent goes through unary so `2^-1` works and `2^3^2` = 2^(3^2).
    const exponent = parseUnary();
    depth--;
    return node({ type: "bin", op: "^", left: base, right: exponent });
  }

  function parsePostfix(): Expr {
    let expr = parsePrimary();
    for (;;) {
      const t = peek();
      if (t.kind !== "op" || t.op !== "!") break;
      pos++;
      expr = node({ type: "fact", arg: expr });
    }
    return expr;
  }

  function expectClose(opener: { closer: ")" | "]" }): void {
    const t = next();
    if (t.kind === "close" && t.char === opener.closer) return;
    fail(t.kind === "comma" ? MSG.comma : MSG.parens);
  }

  function parsePrimary(): Expr {
    const t = next();
    switch (t.kind) {
      case "num":
        return node({ type: "num", value: t.value, text: t.text });
      case "open": {
        const inner = parseExpression();
        expectClose(t);
        return inner;
      }
      case "name":
        return parseName(t.text);
      case "close":
        return fail(MSG.parens);
      case "comma":
        return fail(MSG.comma);
      case "op":
      case "end":
        return fail(MSG.incomplete);
    }
  }

  function parseName(text: string): Expr {
    if (text === "pi") return node({ type: "const", name: "pi" });
    if (text === "e") return node({ type: "const", name: "e" });
    if (scope.includes(text)) return node({ type: "var", name: text });

    const fn = FUNCTIONS.get(text);
    if (!fn) return fail(`Unknown name “${clipName(text)}”.`);
    const opener = next();
    if (opener.kind !== "open") {
      const inputs = fn.arity === 1 ? "the input" : "the inputs";
      return fail(`Put ${inputs} to ${text} in parentheses, like ${fn.example}.`);
    }
    const arityError = `${text} takes ${plural(fn.arity, "input")}, like ${fn.example}.`;

    if (fn.canonical === "sum") return parseSum(opener, arityError);

    const args: Expr[] = [];
    const first = peek();
    if (first.kind === "close") {
      expectClose(opener);
    } else {
      for (;;) {
        args.push(parseExpression());
        const sep = peek();
        if (sep.kind === "comma") {
          pos++;
          continue;
        }
        expectClose(opener);
        break;
      }
    }
    if (args.length !== fn.arity) fail(arityError);
    if (fn.canonical === "fact") return node({ type: "fact", arg: args[0] });
    return node({ type: "call", name: fn.canonical, args });
  }

  function parseSum(opener: { closer: ")" | "]" }, arityError: string): Expr {
    const v = next();
    if (v.kind !== "name" || !SUM_VARS.has(v.text)) fail(MSG.sumVar);
    const expectComma = () => {
      const t = next();
      if (t.kind === "comma") return;
      fail(t.kind === "close" ? arityError : MSG.parens);
    };
    expectComma();
    const lo = parseExpression();
    expectComma();
    const hi = parseExpression();
    expectComma();
    scope.push(v.text);
    const body = parseExpression();
    scope.pop();
    const t = next();
    if (t.kind === "comma") fail(arityError);
    if (t.kind !== "close" || t.char !== opener.closer) fail(MSG.parens);
    return node({ type: "sum", var: v.text, lo, hi, body });
  }

  const expr = parseExpression();
  const rest = peek();
  if (rest.kind === "close") fail(MSG.parens);
  if (rest.kind === "comma") fail(MSG.comma);
  if (rest.kind !== "end") fail(MSG.incomplete);
  return expr;
}

export function parseExpr(input: string): ParseResult {
  try {
    if (typeof input !== "string") return { ok: false, error: MSG.empty };
    if (input.length > MAX_EXPR_CHARS) return { ok: false, error: MSG.tooLong };
    const tokens = tokenize(input);
    if (tokens.length === 1) return { ok: false, error: MSG.empty };
    return { ok: true, expr: parseTokens(tokens) };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

// ---------------------------------------------------------------------------
// Evaluator

interface EvalContext {
  steps: number;
  env: Map<string, number>;
}

function spend(ctx: EvalContext): void {
  ctx.steps++;
  if (ctx.steps > MAX_EVAL_STEPS) fail(MSG.work);
}

function finite(value: number): number {
  if (Number.isNaN(value)) fail(MSG.notReal);
  if (!Number.isFinite(value)) fail(MSG.tooLarge);
  return value;
}

function asInteger(value: number): number | null {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) <= INT_TOL ? rounded : null;
}

const FACTORIALS: readonly number[] = (() => {
  const table = [1];
  for (let i = 1; i <= MAX_FACTORIAL_ARG; i++) table.push(table[i - 1] * i);
  return table;
})();

function factorial(value: number): number {
  const n = asInteger(value);
  if (n === null || n < 0 || n > MAX_FACTORIAL_ARG) fail(MSG.factorial);
  return FACTORIALS[n];
}

function countingArgs(name: "C" | "perm", nValue: number, kValue: number): [number, number] {
  const n = asInteger(nValue);
  const k = asInteger(kValue);
  if (n === null || k === null || n < 0 || k < 0 || n > MAX_CHOOSE_ARG || k > MAX_CHOOSE_ARG) {
    fail(`${name} needs whole numbers from 0 to ${MAX_CHOOSE_ARG}, like ${name}(10, 3).`);
  }
  return [n, k];
}

// Multiplicative formula; each partial product is C(n-k+i, i), so it stays
// exact while it fits in 2^53 and never exceeds k times the final value.
function choose(nValue: number, kValue: number, ctx: EvalContext): number {
  const [n, kRaw] = countingArgs("C", nValue, kValue);
  if (kRaw > n) return 0;
  const k = Math.min(kRaw, n - kRaw);
  let result = 1;
  for (let i = 1; i <= k; i++) {
    spend(ctx);
    result = (result * (n - k + i)) / i;
    if (!Number.isFinite(result)) fail(MSG.tooLarge);
  }
  return result;
}

function perm(nValue: number, kValue: number, ctx: EvalContext): number {
  const [n, k] = countingArgs("perm", nValue, kValue);
  if (k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) {
    spend(ctx);
    result *= n - i;
    if (!Number.isFinite(result)) fail(MSG.tooLarge);
  }
  return result;
}

// Numerical Recipes `erfcc`: Chebyshev fit with fractional error < 1.2e-7
// everywhere, so the tails stay accurate in relative terms.
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? ans : 2 - ans;
}

function standardNormalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

function evalCall(name: CanonicalFn, args: number[], ctx: EvalContext): number {
  const [a, b] = args;
  switch (name) {
    case "C":
      return choose(a, b, ctx);
    case "perm":
      return perm(a, b, ctx);
    case "exp":
      return Math.exp(a);
    case "ln":
      if (a <= 0) fail(MSG.ln);
      return Math.log(a);
    case "sqrt":
      if (a < 0) fail(MSG.sqrt);
      return Math.sqrt(a);
    case "abs":
      return Math.abs(a);
    case "Phi":
      return standardNormalCdf(a);
  }
}

function evalNode(expr: Expr, ctx: EvalContext): number {
  spend(ctx);
  return finite(evalInner(expr, ctx));
}

function evalInner(expr: Expr, ctx: EvalContext): number {
  switch (expr.type) {
    case "num":
      return expr.value;
    case "const":
      return expr.name === "pi" ? Math.PI : Math.E;
    case "var": {
      const value = ctx.env.get(expr.name);
      if (value === undefined) return fail(`Unknown name “${clipName(expr.name)}”.`);
      return value;
    }
    case "neg":
      return -evalNode(expr.arg, ctx);
    case "bin": {
      const left = evalNode(expr.left, ctx);
      const right = evalNode(expr.right, ctx);
      switch (expr.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          if (right === 0) fail(MSG.divZero);
          return left / right;
        case "^":
          if (left === 0 && right < 0) fail(MSG.divZero);
          return Math.pow(left, right);
      }
    }
    case "fact":
      return factorial(evalNode(expr.arg, ctx));
    case "call": {
      if (CALL_ARITY[expr.name] === undefined || expr.args.length !== CALL_ARITY[expr.name]) {
        return fail(MSG.generic);
      }
      const args = expr.args.map((arg) => evalNode(arg, ctx));
      return evalCall(expr.name, args, ctx);
    }
    case "sum": {
      const lo = asInteger(evalNode(expr.lo, ctx));
      const hi = asInteger(evalNode(expr.hi, ctx));
      if (lo === null || hi === null) return fail(MSG.sumBounds);
      if (hi < lo) return 0;
      if (hi - lo + 1 > MAX_SUM_TERMS) return fail(MSG.sumTerms);
      const outer = ctx.env.get(expr.var);
      let total = 0;
      for (let i = lo; i <= hi; i++) {
        ctx.env.set(expr.var, i);
        total = finite(total + evalNode(expr.body, ctx));
      }
      if (outer === undefined) ctx.env.delete(expr.var);
      else ctx.env.set(expr.var, outer);
      return total;
    }
  }
}

export function evaluateExpr(expr: Expr): EvalResult {
  try {
    const value = evalNode(expr, { steps: 0, env: new Map() });
    return { ok: true, value: value === 0 ? 0 : value }; // fold -0 into 0
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

export function evalExpression(input: string): EvalResult {
  const parsed = parseExpr(input);
  if (!parsed.ok) return parsed;
  return evaluateExpr(parsed.expr);
}

// ---------------------------------------------------------------------------
// LaTeX (KaTeX-compatible)

const paren = (latex: string): string => `\\left(${latex}\\right)`;

function isScientific(expr: Expr): boolean {
  return expr.type === "num" && /[eE]/.test(numText(expr));
}

function numText(expr: { value: number; text: string }): string {
  return NUMBER_FULL_RE.test(expr.text) ? expr.text : String(expr.value);
}

function numLatex(expr: { value: number; text: string }): string {
  const text = numText(expr);
  const match = /^(.*?)[eE]([+-]?)0*(\d+)$/.exec(text);
  if (!match) return text;
  const [, mantissa, sign, digits] = match;
  return `${mantissa} \\times 10^{${sign === "-" ? "-" : ""}${digits}}`;
}

function isAddSub(expr: Expr): boolean {
  return expr.type === "bin" && (expr.op === "+" || expr.op === "-");
}

// Atoms that can carry `!` without parentheses.
function isPlainAtom(expr: Expr): boolean {
  return (expr.type === "num" && !isScientific(expr)) || expr.type === "var" || expr.type === "const";
}

// Bases that can take a superscript without parentheses. `exp` already prints
// as a power, so it gets parentheses too.
function isPowerAtom(expr: Expr): boolean {
  return isPlainAtom(expr) || (expr.type === "call" && expr.name !== "exp");
}

function binLatex(expr: Extract<Expr, { type: "bin" }>): string {
  const { op, left, right } = expr;
  if (op === "/") return `\\frac{${latexOf(left)}}{${latexOf(right)}}`;
  if (op === "^") {
    const base = latexOf(left);
    const exponent = latexOf(right);
    return isPowerAtom(left) ? `{${base}}^{${exponent}}` : `${paren(base)}^{${exponent}}`;
  }
  let l = latexOf(left);
  let r = latexOf(right);
  // A sum's body has no closing bracket, so a sum next to an operator always
  // gets parentheses to keep its extent clear.
  if (left.type === "sum" || (op === "*" && isAddSub(left))) l = paren(l);
  if (right.type === "sum" || r.startsWith("-") || (op !== "+" && isAddSub(right))) r = paren(r);
  return `${l}${op === "*" ? " \\cdot " : ` ${op} `}${r}`;
}

function callLatex(expr: Extract<Expr, { type: "call" }>): string {
  const args = expr.args.map(latexOf);
  const [a = "", b = ""] = args;
  switch (expr.name) {
    case "C":
      return `\\binom{${a}}{${b}}`;
    case "perm":
      return `P(${a}, ${b})`;
    case "exp":
      return `e^{${a}}`;
    case "ln":
      return `\\ln\\left(${a}\\right)`;
    case "sqrt":
      return `\\sqrt{${a}}`;
    case "abs":
      return `\\left|${a}\\right|`;
    case "Phi":
      return `\\Phi\\left(${a}\\right)`;
  }
}

function latexOf(expr: Expr): string {
  switch (expr.type) {
    case "num":
      return numLatex(expr);
    case "const":
      return expr.name === "pi" ? "\\pi" : "e";
    case "var":
      return SUM_VARS.has(expr.name) ? expr.name : "?";
    case "neg": {
      const arg = latexOf(expr.arg);
      const wrap = isAddSub(expr.arg) || expr.arg.type === "sum" || arg.startsWith("-");
      return `-${wrap ? paren(arg) : arg}`;
    }
    case "bin":
      return binLatex(expr);
    case "fact": {
      const arg = latexOf(expr.arg);
      return `${isPlainAtom(expr.arg) ? arg : paren(arg)}!`;
    }
    case "call":
      return callLatex(expr);
    case "sum": {
      const v = SUM_VARS.has(expr.var) ? expr.var : "?";
      const body = latexOf(expr.body);
      const shownBody = isAddSub(expr.body) ? paren(body) : body;
      return `\\sum_{${v}=${latexOf(expr.lo)}}^{${latexOf(expr.hi)}} ${shownBody}`;
    }
  }
}

export function toLatex(expr: Expr): string {
  try {
    return latexOf(expr);
  } catch {
    // Only reachable with a hand-built tree deep enough to exhaust the stack;
    // parsed trees are bounded by MAX_DEPTH and MAX_NODES.
    return "";
  }
}

export function expressionToLatex(input: string): LatexResult {
  const parsed = parseExpr(input);
  if (!parsed.ok) return parsed;
  return { ok: true, latex: toLatex(parsed.expr) };
}
