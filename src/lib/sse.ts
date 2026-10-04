import { getSupabaseFunctionsUrl, getSupabaseConfig } from "@/lib/supabase/config";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { AI_BUSY_POLYA_TUTOR } from "@/lib/ai-busy";
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

// Streams polya-tutor, dispatching sources / delta / done / error events.
export async function streamTutor(
  request: TutorRequest,
  handlers: TutorStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const supabase = createBrowserSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    handlers.onError(POLYA_ERROR_SIGNED_OUT, "unauthorized");
    return;
  }

  const response = await fetch(`${getSupabaseFunctionsUrl()}/polya-tutor`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: getSupabaseConfig().anonKey,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok || !response.body) {
    const data = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    if (response.status === 503 && data.code === "busy") {
      // No auto-retry: COPY.md §11 makes the "Try Again" affordance (if any)
      // an explicit user action, never something this client does itself.
      handlers.onError(AI_BUSY_POLYA_TUTOR, "busy");
      return;
    }
    handlers.onError(data.error ?? "The tutor is unavailable right now.", data.code);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const eventMatch = block.match(/event: (\w+)/);
      const dataMatch = block.match(/data: ([\s\S]+)/);
      if (!eventMatch || !dataMatch) continue;
      const payload = JSON.parse(dataMatch[1]!);
      switch (eventMatch[1]) {
        case "sources":
          handlers.onSources(payload);
          break;
        case "delta":
          handlers.onDelta(payload.text);
          break;
        case "done":
          handlers.onDone(payload);
          break;
        case "mastery":
          handlers.onMastery?.(payload);
          break;
        case "error":
          // Budget claims happen before the stream opens (R-5), so a busy
          // refusal is expected on the non-OK branch above, not here — this
          // is defensive in case that ever changes.
          handlers.onError(
            payload.code === "busy" ? AI_BUSY_POLYA_TUTOR : payload.error,
            payload.code,
          );
          break;
      }
    }
  }
}
