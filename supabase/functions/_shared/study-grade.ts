// Grading for practice-question parts. Numeric answers go through the safe
// expression evaluator and are compared within a tolerance; multiple-choice
// and select-all compare choice indices. Written (free-response) parts are
// scored against a rubric by a separate Claude call; this module only applies
// the points that call awarded (parseGraderOutput clamps them). Messages are
// shown to students. Pure module: no runtime globals.
import { evalExpression } from "./study-expr.ts";

export const REL_TOL = 1e-2; // PrairieLearn's default relative tolerance
export const ABS_TOL = 1e-6;

export const MAX_WRITTEN_ANSWER_CHARS = 3_000;

export type PartKey =
  | { kind: "numeric"; expr: string; value: number }
  | { kind: "mc"; correct: number }
  | { kind: "select_all"; correct: number[] }
  | { kind: "free_response"; rubric: string[]; model_answer: string; points: number };

export type PartResponse =
  | { kind: "numeric"; answer: string }
  | { kind: "mc"; choice: number }
  | { kind: "select_all"; choices: number[] }
  | { kind: "free_response"; text: string };

/** What the rubric grader decided for one written part. */
export interface WrittenGrade {
  awarded: number;
  /** 0-based indexes of the rubric points the answer met. */
  met: number[];
  feedback: string;
  /** The one idea that went wrong; "" when nothing did. */
  misconception: string;
}

export type PartResult =
  | {
    ok: true;
    correct: boolean;
    value?: number; // the student's evaluated numeric answer
    // Written parts only: partial credit and the grader's feedback.
    awarded?: number;
    points?: number;
    met?: number[];
    feedback?: string;
    misconception?: string;
  }
  | { ok: false; code: "bad_answer"; message: string };

export interface AttemptGrade {
  results: PartResult[];
  score: number;
  allCorrect: boolean;
}

export type AttemptResult =
  | { ok: true; grade: AttemptGrade }
  | { ok: false; code: "bad_answer"; partIndex: number; message: string };

const MSG = {
  wrongKind: "That answer doesn't fit this question.",
  partCount: "Answer each part of the question once.",
  pickOne: "Pick one of the choices.",
  pickListed: "Pick from the listed choices.",
  numericMissing: "Enter a number or an expression.",
  writeFirst: "Write your answer before submitting.",
  writtenTooLong: "That answer is too long. Keep it under 3,000 characters.",
  notGraded: "Polya couldn't read that answer just now. Please try again.",
};

function badAnswer(message: string): PartResult {
  return { ok: false, code: "bad_answer", message };
}

function isChoiceIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** |answer - key| <= max(rel * |key|, abs). Non-finite inputs never match. */
export function withinTolerance(
  answer: number,
  key: number,
  rel: number = REL_TOL,
  abs: number = ABS_TOL,
): boolean {
  if (!Number.isFinite(answer) || !Number.isFinite(key)) return false;
  return Math.abs(answer - key) <= Math.max(rel * Math.abs(key), abs);
}

export interface GradeOptions {
  /** Grades for written parts, by part index. Required for every written part that has an answer. */
  written?: ReadonlyMap<number, WrittenGrade>;
  /**
   * Timed mock exams: a blank or unreadable answer is simply wrong instead of
   * refusing the whole submission (the clock may have run out mid-answer).
   */
  blankIsWrong?: boolean;
}

/** Whether a response leaves its part unanswered. */
export function isBlankResponse(response: PartResponse | undefined): boolean {
  if (!response) return true;
  switch (response.kind) {
    case "numeric":
      return typeof response.answer !== "string" || response.answer.trim() === "";
    case "mc":
      return !isChoiceIndex(response.choice);
    case "select_all":
      return false; // "none of these" is a real answer
    case "free_response":
      return typeof response.text !== "string" || response.text.trim() === "";
  }
}

function gradeWritten(
  key: Extract<PartKey, { kind: "free_response" }>,
  response: PartResponse,
  grade: WrittenGrade | undefined,
  blankIsWrong: boolean,
): PartResult {
  if (response.kind !== "free_response") return badAnswer(MSG.wrongKind);
  if (typeof response.text !== "string") return badAnswer(MSG.writeFirst);
  if (response.text.length > MAX_WRITTEN_ANSWER_CHARS) return badAnswer(MSG.writtenTooLong);
  if (!response.text.trim()) {
    if (!blankIsWrong) return badAnswer(MSG.writeFirst);
    return { ok: true, correct: false, awarded: 0, points: key.points, met: [], feedback: "", misconception: "" };
  }
  if (!grade) return badAnswer(MSG.notGraded);
  const awarded = Math.max(0, Math.min(key.points, Math.round(grade.awarded)));
  return {
    ok: true,
    correct: awarded === key.points,
    awarded,
    points: key.points,
    met: grade.met,
    feedback: grade.feedback,
    misconception: grade.misconception,
  };
}

export function gradePart(
  key: PartKey,
  response: PartResponse,
  written?: WrittenGrade,
  blankIsWrong = false,
): PartResult {
  if (blankIsWrong && key.kind !== "free_response" && (response?.kind !== key.kind || isBlankResponse(response))) {
    return { ok: true, correct: false };
  }
  switch (key.kind) {
    case "numeric": {
      if (response.kind !== "numeric") return badAnswer(MSG.wrongKind);
      if (typeof response.answer !== "string") return badAnswer(MSG.numericMissing);
      // The evaluator enforces the 300-character cap and returns a
      // student-facing message for anything it can't work out.
      const evaluated = evalExpression(response.answer.trim());
      if (!evaluated.ok) return blankIsWrong ? { ok: true, correct: false } : badAnswer(evaluated.error);
      return { ok: true, correct: withinTolerance(evaluated.value, key.value), value: evaluated.value };
    }
    case "mc": {
      if (response.kind !== "mc") return badAnswer(MSG.wrongKind);
      if (!isChoiceIndex(response.choice)) return badAnswer(MSG.pickOne);
      return { ok: true, correct: response.choice === key.correct };
    }
    case "select_all": {
      if (response.kind !== "select_all") return badAnswer(MSG.wrongKind);
      if (!Array.isArray(response.choices) || !response.choices.every(isChoiceIndex)) {
        return badAnswer(MSG.pickListed);
      }
      const chosen = new Set(response.choices);
      const expected = new Set(key.correct);
      const correct =
        chosen.size === expected.size && Array.from(chosen).every((choice) => expected.has(choice));
      return { ok: true, correct };
    }
    case "free_response":
      return gradeWritten(key, response, written, blankIsWrong);
  }
}

/** A part's share of full marks: 1 or 0, or awarded/points for a written part. */
export function partCredit(result: PartResult): number {
  if (!result.ok) return 0;
  if (typeof result.awarded === "number" && typeof result.points === "number" && result.points > 0) {
    return result.awarded / result.points;
  }
  return result.correct ? 1 : 0;
}

/**
 * Grades every part, or returns the first bad answer (so nothing is recorded).
 * A response-count mismatch reports the first index where the two lists
 * differ in length.
 */
export function gradeAttempt(
  keys: readonly PartKey[],
  responses: readonly PartResponse[],
  options: GradeOptions = {},
): AttemptResult {
  if (keys.length !== responses.length) {
    return {
      ok: false,
      code: "bad_answer",
      partIndex: Math.min(keys.length, responses.length),
      message: MSG.partCount,
    };
  }
  const results: PartResult[] = [];
  for (let i = 0; i < keys.length; i++) {
    const result = gradePart(keys[i]!, responses[i]!, options.written?.get(i), options.blankIsWrong ?? false);
    if (!result.ok) return { ok: false, code: "bad_answer", partIndex: i, message: result.message };
    results.push(result);
  }
  const credit = results.reduce((sum, result) => sum + partCredit(result), 0);
  const score = keys.length === 0 ? 0 : credit / keys.length;
  const allCorrect = keys.length > 0 && results.every((result) => result.ok && result.correct);
  return { ok: true, grade: { results, score, allCorrect } };
}

// ---------------------------------------------------------------------------
// The rubric grader's structured output (one call grades every written part
// in a submission). Items are numbered from 1 in the order they were sent.
// ---------------------------------------------------------------------------
export const GRADER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["grades"],
  properties: {
    grades: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "met", "awarded", "feedback", "misconception"],
        properties: {
          item: { type: "integer" },
          met: { type: "array", items: { type: "integer" } },
          awarded: { type: "integer" },
          feedback: { type: "string" },
          misconception: { type: "string" },
        },
      },
    },
  },
};

const MAX_FEEDBACK_CHARS = 1_500;
const MAX_MISCONCEPTION_CHARS = 300;

/**
 * Reads the grader's reply for `items` (each: its 1-based item number, the
 * part's points and how many rubric points it has). Returns null unless every
 * item has exactly one usable grade. Points are clamped to 0..points and
 * rubric numbers (1-based in the prompt) become 0-based indexes.
 */
export function parseGraderOutput(
  value: unknown,
  items: readonly { item: number; points: number; rubricCount: number }[],
): Map<number, WrittenGrade> | null {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { grades?: unknown }).grades)) {
    return null;
  }
  const wanted = new Map(items.map((item) => [item.item, item]));
  const grades = new Map<number, WrittenGrade>();
  for (const raw of (value as { grades: unknown[] }).grades) {
    if (typeof raw !== "object" || raw === null) return null;
    const g = raw as Record<string, unknown>;
    const spec = typeof g.item === "number" ? wanted.get(g.item) : undefined;
    if (!spec || grades.has(spec.item)) continue;
    if (typeof g.awarded !== "number" || !Number.isFinite(g.awarded)) return null;
    if (typeof g.feedback !== "string" || typeof g.misconception !== "string" || !Array.isArray(g.met)) return null;
    const met = [
      ...new Set(
        g.met.filter((n): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= spec.rubricCount),
      ),
    ]
      .map((n) => n - 1)
      .sort((a, b) => a - b);
    grades.set(spec.item, {
      awarded: Math.max(0, Math.min(spec.points, Math.round(g.awarded))),
      met,
      feedback: g.feedback.trim().slice(0, MAX_FEEDBACK_CHARS),
      misconception: g.misconception.trim().slice(0, MAX_MISCONCEPTION_CHARS),
    });
  }
  return items.every((item) => grades.has(item.item)) ? grades : null;
}
