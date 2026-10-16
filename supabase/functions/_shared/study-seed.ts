// Study: the message that opens a tutor conversation about a practice
// question ("Talk it through"). It's put in the chat box for the student to
// edit and send, never sent for them. Pure module: no runtime globals.

import type { PartResponse } from "./study-grade.ts";
import type { PublicPart } from "./study-questions.ts";

// Matches the tutor's message cap (tutor-limits.ts TUTOR_MESSAGE_MAX_CHARS).
export const PRACTICE_SEED_MAX_CHARS = 8_000;
const LETTERS = ["A", "B", "C", "D", "E", "F"];

function describeResponse(part: PublicPart, response: PartResponse | undefined): string | null {
  if (!response || response.kind !== part.kind) return null;
  if (response.kind === "numeric") return response.answer.trim() || null;
  if (response.kind === "mc") return LETTERS[response.choice] ?? null;
  const letters = response.choices.map((i) => LETTERS[i]).filter(Boolean);
  return letters.length > 0 ? letters.join(", ") : "none";
}

export function buildPracticeSeed(input: {
  stem: string;
  parts: readonly PublicPart[];
  responses?: readonly PartResponse[] | null;
  correct?: readonly boolean[] | null;
}): string {
  const lines = ["I'm working on this practice question:", "", input.stem.trim()];
  input.parts.forEach((part, i) => {
    lines.push("", input.parts.length > 1 ? `Part ${i + 1}: ${part.prompt}` : part.prompt);
    if (part.kind !== "numeric") {
      part.options.forEach((option, j) => lines.push(`${LETTERS[j]}. ${option}`));
    }
    const answer = describeResponse(part, input.responses?.[i]);
    if (answer !== null) {
      const verdict = input.correct?.[i] === true ? " (right)" : input.correct?.[i] === false ? " (wrong)" : "";
      lines.push(`My answer: ${answer}${verdict}`);
    }
  });
  const anyWrong = input.correct?.some((ok) => ok === false);
  lines.push("", anyWrong ? "Can you help me see where my thinking went wrong?" : "Can you help me understand it?");
  const text = lines.join("\n");
  return text.length <= PRACTICE_SEED_MAX_CHARS ? text : `${text.slice(0, PRACTICE_SEED_MAX_CHARS - 1)}…`;
}
