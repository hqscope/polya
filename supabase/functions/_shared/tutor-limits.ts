// Input limits for polya-tutor. Pure module (no Deno globals) so Node's test
// runner covers it directly.

// The student's own message. Lecture Mode context has its own, separate budget
// (LECTURE_CONTEXT_MAX_CHARS in prompts.ts), so pasted board text doesn't
// need to fit in here.
export const TUTOR_MESSAGE_MAX_CHARS = 8_000;

export type TutorMessageCheck = "ok" | "missing" | "too_long";

export function checkTutorMessage(message: unknown): TutorMessageCheck {
  if (typeof message !== "string") return "missing";
  const trimmed = message.trim();
  if (!trimmed) return "missing";
  return trimmed.length > TUTOR_MESSAGE_MAX_CHARS ? "too_long" : "ok";
}
