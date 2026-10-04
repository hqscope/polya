// What the chat shows when a tutor turn doesn't get an answer (POLISH P-12).
// Shown as a notice in the reply slot, never as the tutor speaking, and never
// styled as an alarm (COPY.md §11 for the busy case).
//
// Pure so `tests/` can import it under Node's test runner.

import { AI_BUSY_CODE, AI_BUSY_POLYA_TUTOR, AI_BUSY_POLYA_TUTOR_SHORT } from "./ai-busy.ts";
import { POLYA_ERROR_OFFLINE } from "./user-message.ts";

export { POLYA_ERROR_OFFLINE };

// `polya.chat.failed`
export const POLYA_CHAT_FAILED = "Couldn't get an answer just now.";
// `polya.chat.retry`
export const POLYA_CHAT_RETRY = "Try Again";
// `polya.chat.stop`
export const POLYA_CHAT_STOP = "Stop";

// The tutor writes these messages for the student and they say what to do next
// (shorten the question, take a break, sign in again), so they're shown as-is.
// Anything else gets the fixed line above.
const PASSTHROUGH_CODES = new Set(["too_long", "rate_limited", "unauthorized"]);

export interface ChatFailure {
  message: string;
  /** False when resending the same turn can't work (it's too long). */
  canRetry: boolean;
}

export function describeChatFailure(input: {
  code?: string;
  message?: string;
  offline?: boolean;
  /** The question went back into the composer (a typed turn, not a preset). */
  questionInBox: boolean;
}): ChatFailure {
  if (input.code === AI_BUSY_CODE) {
    // The long line promises "your question is still in the box".
    return {
      message: input.questionInBox ? AI_BUSY_POLYA_TUTOR : AI_BUSY_POLYA_TUTOR_SHORT,
      canRetry: true,
    };
  }
  if (input.offline) return { message: POLYA_ERROR_OFFLINE, canRetry: true };
  const serverMessage = input.message?.trim();
  if (input.code && PASSTHROUGH_CODES.has(input.code) && serverMessage) {
    return { message: serverMessage, canRetry: input.code !== "too_long" };
  }
  return { message: POLYA_CHAT_FAILED, canRetry: true };
}
