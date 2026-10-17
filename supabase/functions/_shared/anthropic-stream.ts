// Reading a streamed /v1/messages reply when the model can call tools.
//
// A tool loop sends the assistant's full content back on the next call, so
// this keeps every block exactly as it arrived: thinking and
// redacted_thinking blocks (with their signatures) must be replayed
// unchanged or the API rejects the request. Tool inputs arrive as
// input_json_delta fragments; they're joined and parsed once, when the block
// ends, never while partial.
//
// Pure module: web-standard globals only (no Deno), so Node tests can import it.

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export interface ToolUse {
  id: string;
  name: string;
  /** Parsed input, or null when the fragments weren't valid JSON. */
  input: Record<string, unknown> | null;
  /** The joined fragments, for an error result when input is null. */
  raw: string;
}

export interface StreamUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface TurnResult {
  content: ContentBlock[];
  stopReason: string | null;
  usage: StreamUsage;
  toolUses: ToolUse[];
  /** A mid-stream `error` event (e.g. overloaded_error), if one arrived. */
  error: string | null;
}

export interface StreamEvent {
  type: string;
  index?: number;
  content_block?: Record<string, unknown>;
  delta?: Record<string, unknown>;
  message?: { usage?: Record<string, unknown> };
  usage?: Record<string, unknown>;
  error?: { type?: string; message?: string };
}

/** Server-sent events from a response body, one parsed `data:` payload each. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = function* (block: string): Generator<StreamEvent> {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
        yield parsed as StreamEvent;
      }
    } catch {
      // A keepalive or a malformed line: skip it.
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) yield* flush(block);
  }
  buffer += decoder.decode().replace(/\r\n?/g, "\n");
  if (buffer.trim()) yield* flush(buffer);
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

interface OpenBlock {
  block: ContentBlock;
  json: string[];
}

/**
 * Accumulates one streamed reply. Feed every event to `onEvent`; it returns
 * any visible text to forward. `result()` gives the content to replay, the
 * tool calls, the stop reason and usage.
 */
export class TurnAccumulator {
  private blocks = new Map<number, OpenBlock>();
  private stopReason: string | null = null;
  private error: string | null = null;
  private usage: StreamUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  onEvent(event: StreamEvent): { text?: string; toolStarted?: string } {
    switch (event.type) {
      case "message_start": {
        const usage = event.message?.usage ?? {};
        this.usage.input_tokens = num(usage.input_tokens);
        this.usage.cache_creation_input_tokens = num(usage.cache_creation_input_tokens);
        this.usage.cache_read_input_tokens = num(usage.cache_read_input_tokens);
        this.usage.output_tokens = num(usage.output_tokens);
        return {};
      }
      case "content_block_start": {
        const index = event.index ?? this.blocks.size;
        const start = event.content_block ?? {};
        const block = startBlock(start);
        if (!block) return {};
        this.blocks.set(index, { block, json: [] });
        if (block.type === "text" && block.text) return { text: block.text };
        if (block.type === "tool_use") return { toolStarted: block.name };
        return {};
      }
      case "content_block_delta": {
        const open = this.blocks.get(event.index ?? -1);
        const delta = event.delta ?? {};
        if (!open) return {};
        const { block } = open;
        if (delta.type === "text_delta" && block.type === "text") {
          const text = str(delta.text);
          block.text += text;
          return text ? { text } : {};
        }
        if (delta.type === "input_json_delta" && block.type === "tool_use") {
          open.json.push(str(delta.partial_json));
        } else if (delta.type === "thinking_delta" && block.type === "thinking") {
          block.thinking += str(delta.thinking);
        } else if (delta.type === "signature_delta" && block.type === "thinking") {
          block.signature += str(delta.signature);
        }
        return {};
      }
      case "content_block_stop":
        return {};
      case "message_delta": {
        const stop = event.delta?.stop_reason;
        if (typeof stop === "string") this.stopReason = stop;
        if (event.usage && typeof event.usage.output_tokens === "number") {
          this.usage.output_tokens = event.usage.output_tokens;
        }
        return {};
      }
      case "error":
        this.error = `${event.error?.type ?? "error"}: ${event.error?.message ?? ""}`.trim();
        return {};
      default:
        return {}; // ping, message_stop
    }
  }

  result(): TurnResult {
    const ordered = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]);
    const content: ContentBlock[] = [];
    const toolUses: ToolUse[] = [];
    for (const [, open] of ordered) {
      const { block } = open;
      if (block.type === "tool_use") {
        const raw = open.json.join("");
        let input: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
        } catch {
          input = null;
        }
        // Replayed content must carry an object; a broken input replays as {}
        // and the tool result tells the model it couldn't be read.
        block.input = input ?? {};
        toolUses.push({ id: block.id, name: block.name, input, raw });
      }
      content.push(block);
    }
    return { content, stopReason: this.stopReason, usage: { ...this.usage }, toolUses, error: this.error };
  }
}

function startBlock(start: Record<string, unknown>): ContentBlock | null {
  switch (start.type) {
    case "text":
      return { type: "text", text: str(start.text) };
    case "thinking":
      return { type: "thinking", thinking: str(start.thinking), signature: str(start.signature) };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: str(start.data) };
    case "tool_use":
      return { type: "tool_use", id: str(start.id), name: str(start.name), input: {} };
    default:
      return null;
  }
}

/** Adds one call's usage into a running total. */
export function addUsage(total: StreamUsage, next: StreamUsage): StreamUsage {
  return {
    input_tokens: total.input_tokens + next.input_tokens,
    output_tokens: total.output_tokens + next.output_tokens,
    cache_creation_input_tokens: total.cache_creation_input_tokens + next.cache_creation_input_tokens,
    cache_read_input_tokens: total.cache_read_input_tokens + next.cache_read_input_tokens,
  };
}

export const ZERO_USAGE: StreamUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};
