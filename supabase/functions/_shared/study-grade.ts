// Deterministic grading for practice-question parts. Numeric answers go
// through the safe expression evaluator and are compared within a tolerance;
// multiple-choice and select-all compare choice indices. Messages are shown to
// students. Pure module: no runtime globals.
import { evalExpression } from "./study-expr.ts";

export const REL_TOL = 1e-2; // PrairieLearn's default relative tolerance
export const ABS_TOL = 1e-6;

export type PartKey =
  | { kind: "numeric"; expr: string; value: number }
  | { kind: "mc"; correct: number }
  | { kind: "select_all"; correct: number[] };

export type PartResponse =
  | { kind: "numeric"; answer: string }
  | { kind: "mc"; choice: number }
  | { kind: "select_all"; choices: number[] };

export type PartResult =
  | { ok: true; correct: boolean; value?: number } // value = the student's evaluated numeric answer
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

export function gradePart(key: PartKey, response: PartResponse): PartResult {
  switch (key.kind) {
    case "numeric": {
      if (response.kind !== "numeric") return badAnswer(MSG.wrongKind);
      if (typeof response.answer !== "string") return badAnswer(MSG.numericMissing);
      // The evaluator enforces the 300-character cap and returns a
      // student-facing message for anything it can't work out.
      const evaluated = evalExpression(response.answer.trim());
      if (!evaluated.ok) return badAnswer(evaluated.error);
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
  }
}

/**
 * Grades every part, or returns the first bad answer (so nothing is recorded).
 * A response-count mismatch reports the first index where the two lists
 * differ in length.
 */
export function gradeAttempt(
  keys: readonly PartKey[],
  responses: readonly PartResponse[],
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
    const result = gradePart(keys[i], responses[i]);
    if (!result.ok) return { ok: false, code: "bad_answer", partIndex: i, message: result.message };
    results.push(result);
  }
  const correctCount = results.filter((result) => result.ok && result.correct).length;
  const score = keys.length === 0 ? 0 : correctCount / keys.length;
  return {
    ok: true,
    grade: { results, score, allCorrect: keys.length > 0 && correctCount === keys.length },
  };
}
