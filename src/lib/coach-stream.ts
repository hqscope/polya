import { openFunctionStream, readEvents, type FunctionStreamCopy, type TutorSource } from "@/lib/sse";
import { AI_BUSY_CODE } from "@/lib/ai-busy";
import { parseCoachBlock, type CoachBlock } from "@/lib/coach";

export const AI_BUSY_POLYA_COACH =
  "Polya can't coach right now. Things are busier than usual, so try again in a little while. Your plan, progress and questions are all saved.";

const COACH_COPY: FunctionStreamCopy = {
  busy: AI_BUSY_POLYA_COACH,
  unavailable: "Polya couldn't answer just now. Please try again.",
};

export type CoachEvent =
  | { kind: "open" }
  | { kind: "attempt"; attempt_id: string }
  | { kind: "mock_submitted"; mock_id: string };

export interface CoachRequest {
  exam_id: string;
  conversation_id?: string;
  client_today: string;
  message?: string;
  event?: CoachEvent;
}

export type CoachStatus = "searching" | "writing_question" | "working";

export interface CoachStreamHandlers {
  onSources: (payload: { sources: TutorSource[]; conversation_id: string }) => void;
  onStatus: (state: CoachStatus) => void;
  onDelta: (text: string) => void;
  onBlock: (block: CoachBlock) => void;
  onDone: (payload: { message_id: string | null }) => void;
  onError: (message: string, code?: string) => void;
}

// Streams one exam-coach turn: sources first (again after a course search),
// then text and interactive blocks in order, then done.
export async function streamCoach(request: CoachRequest, handlers: CoachStreamHandlers, signal?: AbortSignal): Promise<void> {
  const opened = await openFunctionStream("polya-coach", request, signal, COACH_COPY);
  if (!opened.ok) {
    handlers.onError(opened.message, opened.code);
    return;
  }
  await readEvents(opened.response, ({ event, data }) => {
    const payload = (data ?? {}) as Record<string, unknown>;
    switch (event) {
      case "sources":
        if (Array.isArray(payload.sources) && typeof payload.conversation_id === "string") {
          handlers.onSources({ sources: payload.sources as TutorSource[], conversation_id: payload.conversation_id });
        }
        break;
      case "status":
        if (payload.state === "searching" || payload.state === "writing_question" || payload.state === "working") {
          handlers.onStatus(payload.state);
        }
        break;
      case "delta":
        if (typeof payload.text === "string") handlers.onDelta(payload.text);
        break;
      case "block": {
        const block = parseCoachBlock(payload.block);
        if (block) handlers.onBlock(block);
        break;
      }
      case "done":
        handlers.onDone({ message_id: typeof payload.message_id === "string" ? payload.message_id : null });
        break;
      case "error": {
        const code = typeof payload.code === "string" ? payload.code : undefined;
        const message = typeof payload.error === "string" ? payload.error : COACH_COPY.unavailable;
        handlers.onError(code === AI_BUSY_CODE ? AI_BUSY_POLYA_COACH : message, code);
        break;
      }
    }
  });
}
