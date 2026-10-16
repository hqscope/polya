// One Claude call that must come back as JSON matching a schema (structured
// output, `output_config.format`). Used by polya-study for topic suggestions,
// question writing and the independent check. Raw fetch like the tutor and
// OCR, with a hard timeout so a slow reply can't outlive the edge function.
// A refusal, a reply cut off at max_tokens, or anything that isn't the JSON
// asked for is a failure — never a half-read result.
//
// No Deno globals: the caller passes the key, and `readJsonReply` (the part
// worth testing) is pure.

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export type Effort = "low" | "medium" | "high";

export interface ClaudeJsonRequest {
  apiKey: string;
  model: string;
  /** Stable instructions; cached across calls. */
  system: string;
  /** The user turn's content blocks (text, documents). */
  content: unknown[];
  schema: Record<string, unknown>;
  maxTokens: number;
  effort: Effort;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export type ClaudeJsonFailure =
  | "timeout"
  | "refusal"
  | "max_tokens"
  | "bad_json"
  | "overloaded"
  | "http";

export type ClaudeJsonResult =
  | { ok: true; value: unknown; usage: { input_tokens: number; output_tokens: number } }
  | { ok: false; failure: ClaudeJsonFailure; detail: string };

/** Reads a /v1/messages reply body into the parsed JSON it was asked for. */
export function readJsonReply(
  data: unknown,
): { ok: true; value: unknown; usage: { input_tokens: number; output_tokens: number } } | {
  ok: false;
  failure: "refusal" | "max_tokens" | "bad_json";
  detail: string;
} {
  const body = (typeof data === "object" && data !== null ? data : {}) as {
    stop_reason?: unknown;
    stop_details?: { category?: unknown } | null;
    content?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  if (body.stop_reason === "refusal") {
    return { ok: false, failure: "refusal", detail: String(body.stop_details?.category ?? "refusal") };
  }
  if (body.stop_reason === "max_tokens") {
    return { ok: false, failure: "max_tokens", detail: "reply cut off" };
  }
  const text = (Array.isArray(body.content) ? body.content : [])
    .filter((block): block is { type: string; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    )
    .map((block) => block.text)
    .join("");
  try {
    const value: unknown = JSON.parse(text);
    const usage = {
      input_tokens: Number(body.usage?.input_tokens ?? 0) || 0,
      output_tokens: Number(body.usage?.output_tokens ?? 0) || 0,
    };
    return { ok: true, value, usage };
  } catch {
    return { ok: false, failure: "bad_json", detail: `unparseable reply (${text.length} chars)` };
  }
}

export async function callClaudeJson(request: ClaudeJsonRequest): Promise<ClaudeJsonResult> {
  const doFetch = request.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await doFetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": request.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        output_config: {
          effort: request.effort,
          format: { type: "json_schema", schema: request.schema },
        },
        messages: [{ role: "user", content: request.content }],
      }),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      const failure = response.status === 429 || response.status === 529 || response.status >= 500
        ? "overloaded"
        : "http";
      return { ok: false, failure, detail: `${response.status} ${detail}` };
    }
    return readJsonReply(await response.json());
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, failure: "timeout", detail: `over ${request.timeoutMs} ms` };
    return { ok: false, failure: "http", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Base64 for a document block, chunked so large files don't overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
