import { getSupabaseFunctionsUrl, getSupabaseConfig } from "@/lib/supabase/config";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { AI_BUSY_CODE, AI_BUSY_POLYA_TUTOR } from "@/lib/ai-busy";
import { createSSEDecoder, type SSEEvent } from "@/lib/sse-parse";
import { POLYA_ERROR_SIGNED_OUT } from "@/lib/user-message";

export interface TutorSource {
  n: number;
  unit_id: string;
  source_id: string;
  title: string;
  unit_type: string;
  page_start: number | null;
  page_end: number | null;
  t_start_ms: number | null;
  t_end_ms: number | null;
  snippet: string;
}

export type MasteryVerdict = "pass" | "partial" | "fail";

// Lecture Mode. The board text box sends a plain string; a capture client sends
// the structured window. The tutor normalizes both into one shape server-side,
// so nothing here needs to know which surface produced it.
export interface LectureContextInput {
  typed?: string;
  transcript?: string;
  frames?: Array<string | { text: string }>;
  captured_at?: string;
}

// What the room contributed to this answer — shape only. The captured text is
// never echoed back; this exists so the UI can say the board was shortened
// rather than quietly answering half an example.
export interface LiveContextSummary {
  live: boolean;
  captured_at: string | null;
  transcript_chars: number;
  frames: number;
  truncated: boolean;
}

export interface TutorStreamHandlers {
  onSources: (payload: {
    sources: TutorSource[];
    conversation_id: string;
    policy_mode: string;
    live_context?: LiveContextSummary | null;
  }) => void;
  onDelta: (text: string) => void;
  onDone: (payload: { message_id: string | null; mastery_check_id?: string | null }) => void;
  /** `code` is `"busy"` when the project-wide AI budget (agent_plan R-5) is
   * spent for the day; `message` is already the right copy to show either
   * way (COPY.md §11's `ai.busy.polya.tutor` for busy). */
  onError: (message: string, code?: string) => void;
  /** Fired on a mastery-answer turn once the tutor has judged the attempt. */
  onMastery?: (payload: { check_id: string; verdict: MasteryVerdict }) => void;
}

export interface TutorRequest {
  course_id: string;
  message: string;
  conversation_id?: string;
  attempt?: boolean;
  mastery?: { phase: "start"; concept: string } | { phase: "answer"; check_id: string };
  context?: string | LectureContextInput;
}

export type FunctionStreamOpen =
  | { ok: true; response: Response }
  | { ok: false; message: string; code?: string; status: number };

export interface FunctionStreamCopy {
  /** Shown when the AI budget is spent for the day (503 + code "busy"). */
  busy: string;
  /** Shown when the function fails without its own message. */
  unavailable: string;
}

const TUTOR_COPY: FunctionStreamCopy = {
  busy: AI_BUSY_POLYA_TUTOR,
  unavailable: "The tutor is unavailable right now.",
};

// POSTs to a streaming edge function as the signed-in student. Resolves with
// the open response, or with the message to show when it couldn't start.
// No auto-retry on busy: COPY.md §11 makes "Try Again" an explicit user action.
export async function openFunctionStream(
  name: string,
  body: unknown,
  signal?: AbortSignal,
  copy: FunctionStreamCopy = TUTOR_COPY,
): Promise<FunctionStreamOpen> {
  const supabase = createBrowserSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return { ok: false, message: POLYA_ERROR_SIGNED_OUT, code: "unauthorized", status: 401 };
  }

  const response = await fetch(`${getSupabaseFunctionsUrl()}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: getSupabaseConfig().anonKey,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    const data = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    if (response.status === 503 && data.code === AI_BUSY_CODE) {
      return { ok: false, message: copy.busy, code: AI_BUSY_CODE, status: response.status };
    }
    return { ok: false, message: data.error ?? copy.unavailable, code: data.code, status: response.status };
  }
  return { ok: true, response };
}

// Reads an open stream to the end, handing each event to `onEvent` as it
// completes. Rejects if the request is aborted mid-read.
export async function readEvents(response: Response, onEvent: (event: SSEEvent) => void): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = createSSEDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const event of sse.push(decoder.decode(value, { stream: true }))) onEvent(event);
  }
  const tail = decoder.decode();
  if (tail) for (const event of sse.push(tail)) onEvent(event);
}

// Streams polya-tutor, dispatching sources / delta / done / error events.
export async function streamTutor(
  request: TutorRequest,
  handlers: TutorStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const opened = await openFunctionStream("polya-tutor", request, signal);
  if (!opened.ok) {
    handlers.onError(opened.message, opened.code);
    return;
  }

  await readEvents(opened.response, ({ event, data }) => {
    const payload = (data ?? {}) as Record<string, unknown>;
    switch (event) {
      case "sources":
        handlers.onSources(payload as Parameters<TutorStreamHandlers["onSources"]>[0]);
        break;
      case "delta":
        handlers.onDelta(typeof payload.text === "string" ? payload.text : "");
        break;
      case "done":
        handlers.onDone(payload as Parameters<TutorStreamHandlers["onDone"]>[0]);
        break;
      case "mastery":
        handlers.onMastery?.(payload as Parameters<NonNullable<TutorStreamHandlers["onMastery"]>>[0]);
        break;
      case "error": {
        // Budget claims happen before the stream opens (R-5), so a busy
        // refusal is expected on the non-OK branch above, not here — this
        // is defensive in case that ever changes.
        const code = typeof payload.code === "string" ? payload.code : undefined;
        const message = typeof payload.error === "string" ? payload.error : TUTOR_COPY.unavailable;
        handlers.onError(code === AI_BUSY_CODE ? AI_BUSY_POLYA_TUTOR : message, code);
        break;
      }
    }
  });
}
