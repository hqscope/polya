import { getSupabaseFunctionsUrl, getSupabaseConfig } from "@/lib/supabase/config";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

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

export interface TutorStreamHandlers {
  onSources: (payload: {
    sources: TutorSource[];
    conversation_id: string;
    policy_mode: string;
  }) => void;
  onDelta: (text: string) => void;
  onDone: (payload: { message_id: string | null; mastery_check_id?: string | null }) => void;
  onError: (message: string) => void;
  /** Fired on a mastery-answer turn once the tutor has judged the attempt. */
  onMastery?: (payload: { check_id: string; verdict: MasteryVerdict }) => void;
}

export interface TutorRequest {
  course_id: string;
  message: string;
  conversation_id?: string;
  attempt?: boolean;
  mastery?: { phase: "start"; concept: string } | { phase: "answer"; check_id: string };
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
    handlers.onError("You're signed out. Please sign in again.");
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
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    handlers.onError(data.error ?? "The tutor is unavailable right now.");
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
          handlers.onError(payload.error);
          break;
      }
    }
  }
}
