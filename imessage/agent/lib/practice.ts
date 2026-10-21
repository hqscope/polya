// Practice questions over text. Pure (test/practice.test.ts): shows a Study question as plain
// facts, reads the student's texted answers into the shape polya-study grades, and turns its
// graded reply into what the agent explains. Questions and keys live in polya_practice_questions
// and polya_practice_keys; grading always happens in polya-study (study-api.ts), never here, so
// an answer texted to Polya counts exactly like one given on the website.
//
// Parts are labelled a, b, c in order. Choices are numbered from 1, and a texted "B" or "2" both
// mean the second choice.

export type PublicPart =
  | { readonly kind: "numeric"; readonly prompt: string }
  | { readonly kind: "mc"; readonly prompt: string; readonly options: readonly string[] }
  | { readonly kind: "select_all"; readonly prompt: string; readonly options: readonly string[] }
  | { readonly kind: "free_response"; readonly prompt: string; readonly points?: number };

export type PartResponse =
  | { kind: "numeric"; answer: string }
  | { kind: "mc"; choice: number }
  | { kind: "select_all"; choices: number[] }
  | { kind: "free_response"; text: string };

/** A practice question row, as much of it as text practice needs (never the key). */
export interface PracticeQuestion {
  readonly id: string;
  readonly stem: string;
  readonly parts: readonly PublicPart[];
  readonly hideTopic: boolean;
}

/** polya-study's submit_attempt reply (supabase/functions/polya-study/index.ts). */
export interface GradedReply {
  readonly results: readonly {
    readonly ok?: boolean;
    readonly correct?: boolean;
    readonly awarded?: number;
    readonly points?: number;
    readonly feedback?: string;
  }[];
  readonly score: number;
  readonly all_correct: boolean;
  readonly answers: readonly (
    | { readonly kind: "numeric"; readonly expr: string; readonly value: number }
    | { readonly kind: "mc"; readonly correct: number }
    | { readonly kind: "select_all"; readonly correct: readonly number[] }
    | { readonly kind: "free_response"; readonly model_answer: string; readonly points: number }
  )[];
  readonly explanation: string;
  readonly sources?: readonly { readonly n?: number; readonly title?: string; readonly page_start?: number | null }[];
}

const MAX_ANSWER_CHARS = 300;
const MAX_WRITTEN_CHARS = 3_000;

const HOW_TO_ANSWER: Readonly<Record<PublicPart["kind"], string>> = {
  numeric: "a number or an expression, like 0.42 or 1 - (5/6)^3",
  mc: "one choice, by its number",
  select_all: "every choice that applies, by number, like 1, 3",
  free_response: "a short written explanation",
};

export function partLabel(index: number): string {
  return String.fromCharCode(97 + index);
}

/** The question as the practice_question tool returns it. */
export function questionView(question: PracticeQuestion, topic: string | null) {
  return {
    question_id: question.id,
    topic: question.hideTopic ? null : topic,
    stem: question.stem,
    parts: question.parts.map((part, i) => ({
      part: partLabel(i),
      prompt: part.prompt,
      how_to_answer: HOW_TO_ANSWER[part.kind],
      ...(part.kind === "mc" || part.kind === "select_all"
        ? { choices: part.options.map((text, n) => ({ number: n + 1, text })) }
        : {}),
    })),
  };
}

export type ParsedAnswers =
  | { readonly ok: true; readonly responses: PartResponse[] }
  | { readonly ok: false; readonly part: string; readonly reason: string };

/** Reads one texted answer per part, in order, into the shape polya-study grades. */
export function parseAnswers(parts: readonly PublicPart[], answers: readonly string[]): ParsedAnswers {
  if (answers.length !== parts.length) {
    return {
      ok: false,
      part: partLabel(Math.min(answers.length, parts.length - 1)),
      reason: `This question has ${parts.length} part${parts.length === 1 ? "" : "s"}. Pass one answer for each, in order.`,
    };
  }
  const responses: PartResponse[] = [];
  for (const [i, part] of parts.entries()) {
    const raw = (answers[i] ?? "").trim();
    const label = partLabel(i);
    if (!raw) return { ok: false, part: label, reason: "That part has no answer yet." };
    if (part.kind === "numeric") {
      if (raw.length > MAX_ANSWER_CHARS) return { ok: false, part: label, reason: "That answer is too long." };
      responses.push({ kind: "numeric", answer: raw });
    } else if (part.kind === "mc") {
      const choices = readChoices(raw, part.options);
      if (choices.length !== 1) return { ok: false, part: label, reason: "Pick exactly one choice, by its number." };
      responses.push({ kind: "mc", choice: choices[0]! });
    } else if (part.kind === "select_all") {
      const choices = readChoices(raw, part.options);
      if (choices.length === 0) return { ok: false, part: label, reason: "Name the choices that apply, by number." };
      responses.push({ kind: "select_all", choices });
    } else {
      if (raw.length > MAX_WRITTEN_CHARS) return { ok: false, part: label, reason: "That answer is too long for this part." };
      responses.push({ kind: "free_response", text: raw });
    }
  }
  return { ok: true, responses };
}

/**
 * Choice indexes (0-based, sorted, unique) from "2", "B", "1, 3", "a and c", or a choice's exact
 * text. Anything that names a choice that doesn't exist reads as nothing.
 */
export function readChoices(raw: string, options: readonly string[]): number[] {
  const exact = options.findIndex((option) => option.trim().toLowerCase() === raw.trim().toLowerCase());
  if (exact >= 0) return [exact];
  const tokens = raw
    .toLowerCase()
    .replace(/\b(and|or|choice|choices|option|options)\b/g, " ")
    .split(/[\s,;/&+]+/)
    .map((token) => token.replace(/^[(]|[).:]$/g, ""))
    .filter(Boolean);
  const picked = new Set<number>();
  for (const token of tokens) {
    let index: number;
    if (/^\d+$/.test(token)) index = Number(token) - 1;
    else if (/^[a-z]$/.test(token)) index = token.charCodeAt(0) - 97;
    else return [];
    if (index < 0 || index >= options.length) return [];
    picked.add(index);
  }
  return [...picked].sort((a, b) => a - b);
}

/** The graded result as the answer_practice tool returns it: per part, what was right and the key. */
export function gradedView(question: PracticeQuestion, responses: readonly PartResponse[], reply: GradedReply) {
  return {
    graded: true,
    all_correct: reply.all_correct,
    score: `${Math.round(reply.score * 100)}%`,
    parts: question.parts.map((part, i) => {
      const result = reply.results[i] ?? {};
      const key = reply.answers[i];
      const outOf = result.points ?? (key?.kind === "free_response" ? key.points : undefined);
      return {
        part: partLabel(i),
        correct: result.correct === true,
        your_answer: describeResponse(part, responses[i]),
        correct_answer: describeKey(part, key),
        ...(part.kind === "free_response" && typeof result.awarded === "number"
          ? { points: `${result.awarded} of ${outOf ?? "?"}` }
          : {}),
        ...(result.feedback ? { feedback: result.feedback } : {}),
      };
    }),
    worked_solution: reply.explanation,
    sources: (reply.sources ?? []).slice(0, 4).map((source) => ({
      n: source.n ?? null,
      title: source.title ?? "Course material",
      page: source.page_start ?? null,
    })),
  };
}

function describeResponse(part: PublicPart, response: PartResponse | undefined): string {
  if (!response) return "";
  if (response.kind === "numeric") return response.answer;
  if (response.kind === "free_response") return response.text;
  const options = part.kind === "mc" || part.kind === "select_all" ? part.options : [];
  const picked = response.kind === "mc" ? [response.choice] : response.choices;
  return picked.map((i) => `${i + 1}. ${options[i] ?? ""}`.trim()).join("; ");
}

function describeKey(part: PublicPart, key: GradedReply["answers"][number] | undefined): string {
  if (!key) return "";
  if (key.kind === "numeric") return `${key.expr} (about ${roundForText(key.value)})`;
  if (key.kind === "free_response") return key.model_answer;
  const options = part.kind === "mc" || part.kind === "select_all" ? part.options : [];
  const correct = key.kind === "mc" ? [key.correct] : [...key.correct];
  return correct.map((i) => `${i + 1}. ${options[i] ?? ""}`.trim()).join("; ");
}

function roundForText(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Number(value.toPrecision(4)).toString();
}
