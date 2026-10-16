// Study: turning a model's practice questions into what the student sees and
// a key graded by fixed rules — and refusing any question whose key can't be
// trusted. Pure module: no runtime globals.
//
// Every number in a key is an arithmetic expression evaluated here
// (study-expr.ts), never a number the model typed. A multiple-choice question
// whose options are numbers keeps exactly one option equal to the computed
// answer. A second, independent solve (the "checker", which never sees the
// key) must then reach the same answers, or the question is dropped.

import { evalExpression, expressionToLatex } from "./study-expr.ts";
import { withinTolerance, type PartKey, type PartResponse } from "./study-grade.ts";

export const QUESTIONS_PER_CALL = 2;
export const MAX_PARTS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
const MAX_STEM_CHARS = 4_000;
const MAX_PROMPT_CHARS = 1_200;
const MAX_OPTION_CHARS = 400;
const MAX_EXPLANATION_CHARS = 8_000;
const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

export type PartKind = "numeric" | "mc" | "select_all";

// ---------------------------------------------------------------------------
// What the question writer returns (structured output, WRITER_SCHEMA).
// ---------------------------------------------------------------------------
export interface WriterOption {
  expr: string;
  text: string;
  correct: boolean;
}

export interface WriterPart {
  kind: PartKind;
  prompt: string;
  answer_expr: string;
  options: WriterOption[];
}

export interface WriterQuestion {
  stem: string;
  parts: WriterPart[];
  explanation: string;
}

// What the student sees. Option strings may carry \( … \) math.
export type PublicPart =
  | { kind: "numeric"; prompt: string }
  | { kind: "mc"; prompt: string; options: string[] }
  | { kind: "select_all"; prompt: string; options: string[] };

export interface PreparedQuestion {
  stem: string;
  parts: PublicPart[];
  keys: PartKey[];
  explanation: string;
}

export type PrepareResult = { ok: true; question: PreparedQuestion } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// JSON schemas for structured output. No length or numeric constraints (the
// API rejects them); every object closes with additionalProperties: false.
// Limits are enforced below instead.
// ---------------------------------------------------------------------------
const OPTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["expr", "text", "correct"],
  properties: {
    expr: { type: "string" },
    text: { type: "string" },
    correct: { type: "boolean" },
  },
};

export const WRITER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stem", "parts", "explanation"],
        properties: {
          stem: { type: "string" },
          parts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "prompt", "answer_expr", "options"],
              properties: {
                kind: { type: "string", enum: ["numeric", "mc", "select_all"] },
                prompt: { type: "string" },
                answer_expr: { type: "string" },
                options: { type: "array", items: OPTION_SCHEMA },
              },
            },
          },
          explanation: { type: "string" },
        },
      },
    },
  },
};

export const CHECKER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["problem", "parts"],
        properties: {
          problem: { type: "string" },
          parts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["answer_expr", "choices"],
              properties: {
                answer_expr: { type: "string" },
                choices: { type: "array", items: { type: "string", enum: [...OPTION_LETTERS] } },
              },
            },
          },
        },
      },
    },
  },
};

export const TOPICS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topics"],
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "summary", "key_formulas", "source_refs"],
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          key_formulas: { type: "array", items: { type: "string" } },
          source_refs: { type: "array", items: { type: "integer" } },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Shape checks on parsed model output (structured output guarantees the
// schema, but a refusal or truncation can still hand back something else).
// ---------------------------------------------------------------------------
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";

function asWriterPart(value: unknown): WriterPart | null {
  if (!isObject(value)) return null;
  const { kind, prompt, answer_expr, options } = value;
  if (kind !== "numeric" && kind !== "mc" && kind !== "select_all") return null;
  if (!isString(prompt) || !isString(answer_expr) || !Array.isArray(options)) return null;
  const opts: WriterOption[] = [];
  for (const option of options) {
    if (!isObject(option) || !isString(option.expr) || !isString(option.text) || typeof option.correct !== "boolean") {
      return null;
    }
    opts.push({ expr: option.expr, text: option.text, correct: option.correct });
  }
  return { kind, prompt, answer_expr, options: opts };
}

export function parseWriterOutput(value: unknown): WriterQuestion[] | null {
  if (!isObject(value) || !Array.isArray(value.questions)) return null;
  const questions: WriterQuestion[] = [];
  for (const q of value.questions) {
    if (!isObject(q) || !isString(q.stem) || !isString(q.explanation) || !Array.isArray(q.parts)) return null;
    const parts = q.parts.map(asWriterPart);
    if (parts.some((part) => part === null)) return null;
    questions.push({ stem: q.stem, parts: parts as WriterPart[], explanation: q.explanation });
  }
  return questions;
}

export interface CheckerPart {
  answer_expr: string;
  choices: string[];
}

export interface CheckerAnswer {
  problem: string;
  parts: CheckerPart[];
}

export function parseCheckerOutput(value: unknown): CheckerAnswer[] | null {
  if (!isObject(value) || !Array.isArray(value.answers)) return null;
  const answers: CheckerAnswer[] = [];
  for (const answer of value.answers) {
    if (!isObject(answer) || !isString(answer.problem) || !Array.isArray(answer.parts)) return null;
    const parts: CheckerPart[] = [];
    for (const part of answer.parts) {
      if (!isObject(part) || !isString(part.answer_expr) || !Array.isArray(part.choices)) return null;
      if (!part.choices.every(isString)) return null;
      parts.push({ answer_expr: part.answer_expr, choices: part.choices as string[] });
    }
    answers.push({ problem: answer.problem, parts });
  }
  return answers;
}

// ---------------------------------------------------------------------------
// Citations: an explanation may only cite evidence it was given.
// ---------------------------------------------------------------------------
export function stripInvalidCitations(text: string, sourceCount: number): string {
  return text
    .replace(/\s?\[(\d{1,3})\]/g, (whole, n: string) => {
      const value = Number(n);
      return value >= 1 && value <= sourceCount ? whole : "";
    })
    .trim();
}

// ---------------------------------------------------------------------------
// Preparing one question.
// ---------------------------------------------------------------------------
function clean(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

// Options whose position carries meaning stay in the order written.
const POSITIONAL_OPTION_RE = /^(true|false|yes|no|both\b|neither\b|none of|all of)/i;

function shuffledOrder(length: number, random: () => number): number[] {
  const order = Array.from({ length }, (_, i) => i);
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

type PartResult = { ok: true; part: PublicPart; key: PartKey } | { ok: false; reason: string };

function prepareNumeric(prompt: string, part: WriterPart): PartResult {
  const expr = part.answer_expr.trim();
  const value = evalExpression(expr);
  if (!value.ok) return { ok: false, reason: `answer doesn't evaluate: ${value.error}` };
  return { ok: true, part: { kind: "numeric", prompt }, key: { kind: "numeric", expr, value: value.value } };
}

function prepareChoices(prompt: string, part: WriterPart, random: () => number): PartResult {
  const options = part.options;
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    return { ok: false, reason: `${options.length} options` };
  }
  const numericOptions = part.kind === "mc" && options.every((option) => option.expr.trim() !== "");
  let display: string[];
  let correct: number[];

  if (numericOptions) {
    // Options are values: render each from the expression actually checked,
    // and let the computed answer — not the model's flag — pick the key.
    const values: number[] = [];
    display = [];
    for (const option of options) {
      const value = evalExpression(option.expr.trim());
      const latex = expressionToLatex(option.expr.trim());
      if (!value.ok || !latex.ok) return { ok: false, reason: "an option doesn't evaluate" };
      values.push(value.value);
      display.push(`\\(${latex.latex}\\)`);
    }
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        if (withinTolerance(values[i]!, values[j]!)) return { ok: false, reason: "two options have the same value" };
      }
    }
    const answer = evalExpression(part.answer_expr.trim());
    if (!answer.ok) return { ok: false, reason: "answer doesn't evaluate" };
    const matching = values.flatMap((value, i) => (withinTolerance(value, answer.value) ? [i] : []));
    if (matching.length !== 1) return { ok: false, reason: `${matching.length} options equal the answer` };
    const flagged = options.flatMap((option, i) => (option.correct ? [i] : []));
    if (flagged.length !== 1 || flagged[0] !== matching[0]) {
      return { ok: false, reason: "the marked option isn't the computed answer" };
    }
    correct = matching;
  } else {
    display = options.map((option) => clean(option.text));
    if (display.some((text) => !text || text.length > MAX_OPTION_CHARS)) {
      return { ok: false, reason: "an option is empty or too long" };
    }
    if (new Set(display.map((text) => text.toLowerCase())).size !== display.length) {
      return { ok: false, reason: "two options are the same" };
    }
    correct = options.flatMap((option, i) => (option.correct ? [i] : []));
    if (part.kind === "mc" && correct.length !== 1) return { ok: false, reason: `${correct.length} options marked correct` };
    if (part.kind === "select_all" && correct.length === 0) return { ok: false, reason: "no option marked correct" };
  }

  const keepOrder = display.some((text) => POSITIONAL_OPTION_RE.test(text));
  const order = keepOrder ? display.map((_, i) => i) : shuffledOrder(display.length, random);
  const shownOptions = order.map((i) => display[i]!);
  const shownCorrect = correct.map((i) => order.indexOf(i)).sort((a, b) => a - b);

  if (part.kind === "mc") {
    return { ok: true, part: { kind: "mc", prompt, options: shownOptions }, key: { kind: "mc", correct: shownCorrect[0]! } };
  }
  return {
    ok: true,
    part: { kind: "select_all", prompt, options: shownOptions },
    key: { kind: "select_all", correct: shownCorrect },
  };
}

export function prepareQuestion(
  question: WriterQuestion,
  sourceCount: number,
  random: () => number = Math.random,
): PrepareResult {
  const stem = clean(question.stem);
  if (!stem || stem.length > MAX_STEM_CHARS) return { ok: false, reason: "stem is empty or too long" };
  if (question.parts.length < 1 || question.parts.length > MAX_PARTS) {
    return { ok: false, reason: `${question.parts.length} parts` };
  }
  const parts: PublicPart[] = [];
  const keys: PartKey[] = [];
  for (const [i, part] of question.parts.entries()) {
    const prompt = clean(part.prompt);
    if (!prompt || prompt.length > MAX_PROMPT_CHARS) return { ok: false, reason: `part ${i + 1}: prompt is empty or too long` };
    const result = part.kind === "numeric" ? prepareNumeric(prompt, part) : prepareChoices(prompt, part, random);
    if (!result.ok) return { ok: false, reason: `part ${i + 1}: ${result.reason}` };
    parts.push(result.part);
    keys.push(result.key);
  }
  const explanation = stripInvalidCitations(clean(question.explanation), sourceCount);
  if (!explanation || explanation.length > MAX_EXPLANATION_CHARS) {
    return { ok: false, reason: "explanation is empty or too long" };
  }
  return { ok: true, question: { stem, parts, keys, explanation } };
}

// ---------------------------------------------------------------------------
// The independent check.
// ---------------------------------------------------------------------------

/** One question as the checker reads it: options lettered, no key, no explanation. */
export function questionForChecker(index: number, question: { stem: string; parts: PublicPart[] }): string {
  const lines = [`QUESTION ${index + 1}`, question.stem];
  question.parts.forEach((part, i) => {
    const kindLabel =
      part.kind === "numeric" ? "numeric answer" : part.kind === "mc" ? "choose one" : "select all that apply";
    lines.push(`Part ${i + 1} (${kindLabel}): ${part.prompt}`);
    if (part.kind !== "numeric") {
      part.options.forEach((option, j) => lines.push(`  ${OPTION_LETTERS[j]}. ${option}`));
    }
  });
  return lines.join("\n");
}

function letterIndexes(choices: string[]): number[] | null {
  const indexes = choices.map((letter) => OPTION_LETTERS.indexOf(letter as (typeof OPTION_LETTERS)[number]));
  if (indexes.some((i) => i < 0)) return null;
  return [...new Set(indexes)].sort((a, b) => a - b);
}

export type Agreement = { agree: true } | { agree: false; reason: string };

export function checkAgreement(keys: readonly PartKey[], answer: CheckerAnswer | undefined): Agreement {
  if (!answer) return { agree: false, reason: "no independent answer" };
  if (answer.problem.trim()) return { agree: false, reason: `flagged: ${answer.problem.trim().slice(0, 200)}` };
  if (answer.parts.length !== keys.length) return { agree: false, reason: "answered a different number of parts" };
  for (const [i, key] of keys.entries()) {
    const part = answer.parts[i]!;
    if (key.kind === "numeric") {
      const value = evalExpression(part.answer_expr.trim());
      if (!value.ok) return { agree: false, reason: `part ${i + 1}: independent answer doesn't evaluate` };
      if (!withinTolerance(value.value, key.value)) {
        return { agree: false, reason: `part ${i + 1}: independent answer ${value.value} vs key ${key.value}` };
      }
      continue;
    }
    const chosen = letterIndexes(part.choices);
    if (!chosen) return { agree: false, reason: `part ${i + 1}: unreadable choice` };
    const expected = key.kind === "mc" ? [key.correct] : key.correct;
    if (chosen.length !== expected.length || chosen.some((c, j) => c !== expected[j])) {
      return { agree: false, reason: `part ${i + 1}: independent choice differs` };
    }
  }
  return { agree: true };
}

// ---------------------------------------------------------------------------
// Topic suggestions.
// ---------------------------------------------------------------------------
export const MIN_TOPICS = 3;
export const MAX_TOPICS = 14;

export interface ProposedTopic {
  title: string;
  summary: string;
  key_formulas: string[];
  /** Indexes into the file list the model was shown (0-based). */
  source_indexes: number[];
}

export function parseTopicsOutput(value: unknown, fileCount: number): ProposedTopic[] | null {
  if (!isObject(value) || !Array.isArray(value.topics)) return null;
  const topics: ProposedTopic[] = [];
  const seen = new Set<string>();
  for (const topic of value.topics) {
    if (!isObject(topic) || !isString(topic.title) || !isString(topic.summary)) return null;
    if (!Array.isArray(topic.key_formulas) || !Array.isArray(topic.source_refs)) return null;
    const title = topic.title.replace(/\s+/g, " ").trim().slice(0, 160);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const formulas = topic.key_formulas
      .filter(isString)
      .map((tex) => tex.trim().replace(/^\\\(|\\\)$|^\$+|\$+$/g, "").trim())
      .filter((tex) => tex && tex.length <= 300)
      .slice(0, 6);
    // The model numbers files from 1.
    const indexes = [
      ...new Set(
        topic.source_refs.filter(
          (n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= fileCount,
        ),
      ),
    ]
      .slice(0, 8)
      .map((n) => n - 1);
    topics.push({
      title,
      summary: topic.summary.replace(/\s+/g, " ").trim().slice(0, 600),
      key_formulas: formulas,
      source_indexes: indexes,
    });
    if (topics.length === MAX_TOPICS) break;
  }
  return topics.length >= MIN_TOPICS ? topics : null;
}

// ---------------------------------------------------------------------------
// A student's submitted answers, read from an untrusted request body.
// ---------------------------------------------------------------------------
export function parseResponses(value: unknown): PartResponse[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PARTS) return null;
  const responses: PartResponse[] = [];
  for (const item of value) {
    if (!isObject(item)) return null;
    if (item.kind === "numeric" && isString(item.answer) && item.answer.length <= 300) {
      responses.push({ kind: "numeric", answer: item.answer });
    } else if (item.kind === "mc" && Number.isInteger(item.choice)) {
      responses.push({ kind: "mc", choice: item.choice as number });
    } else if (
      item.kind === "select_all" &&
      Array.isArray(item.choices) &&
      item.choices.length <= MAX_OPTIONS &&
      item.choices.every((c) => Number.isInteger(c))
    ) {
      responses.push({ kind: "select_all", choices: item.choices as number[] });
    } else {
      return null;
    }
  }
  return responses;
}
