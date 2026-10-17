import { test } from "node:test";
import assert from "node:assert/strict";

import { readSse, TurnAccumulator, type StreamEvent } from "../supabase/functions/_shared/anthropic-stream.ts";

function body(text: string, chunk = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(i, i + chunk));
      i += chunk;
    },
  });
}

const sse = (events: object[], eol = "\n") =>
  events.map((e) => `event: ${(e as { type: string }).type}${eol}data: ${JSON.stringify(e)}${eol}${eol}`).join("");

async function collect(text: string, chunk?: number): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of readSse(body(text, chunk))) out.push(event);
  return out;
}

const TOOL_TURN = [
  { type: "message_start", message: { usage: { input_tokens: 900, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Here's one " } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "to try." } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "redacted_thinking", data: "opaque==" } },
  { type: "content_block_stop", index: 2 },
  { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "toolu_1", name: "search_course", input: {} } },
  { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "{\"que" } },
  { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "ry\": \"Chebyshev\"}" } },
  { type: "content_block_stop", index: 3 },
  { type: "content_block_start", index: 4, content_block: { type: "tool_use", id: "toolu_2", name: "show_inventory", input: {} } },
  { type: "content_block_stop", index: 4 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 140 } },
  { type: "message_stop" },
];

test("readSse survives chunk splits at every size and CRLF line endings", async () => {
  const text = sse(TOOL_TURN);
  for (const chunk of [1, 3, 7, 64, 100_000]) {
    assert.equal((await collect(text, chunk)).length, TOOL_TURN.length, `chunk ${chunk}`);
  }
  assert.equal((await collect(sse(TOOL_TURN, "\r\n"), 5)).length, TOOL_TURN.length);
  assert.equal((await collect("event: ping\ndata: {not json}\n\n" + sse(TOOL_TURN))).length, TOOL_TURN.length);
});

test("the accumulator keeps thinking blocks exactly and joins tool input once", async () => {
  const acc = new TurnAccumulator();
  let text = "";
  const started: string[] = [];
  for await (const event of readSse(body(sse(TOOL_TURN), 11))) {
    const out = acc.onEvent(event);
    if (out.text) text += out.text;
    if (out.toolStarted) started.push(out.toolStarted);
  }
  const result = acc.result();
  assert.equal(text, "Here's one to try.");
  assert.deepEqual(started, ["search_course", "show_inventory"]);
  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(result.content[0], { type: "thinking", thinking: "", signature: "sig-abc" });
  assert.deepEqual(result.content[2], { type: "redacted_thinking", data: "opaque==" });
  assert.deepEqual(result.content[3], { type: "tool_use", id: "toolu_1", name: "search_course", input: { query: "Chebyshev" } });
  assert.deepEqual(result.toolUses.map((t) => t.input), [{ query: "Chebyshev" }, {}]);
  assert.deepEqual(result.usage, {
    input_tokens: 900,
    output_tokens: 140,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 4000,
  });
});

test("broken tool JSON, refusals and mid-stream errors are reported, not thrown", () => {
  const acc = new TurnAccumulator();
  for (const event of [
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "ask_question", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"stem\": \"cut off" } },
    { type: "message_delta", delta: { stop_reason: "max_tokens" } },
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  ] as StreamEvent[]) {
    acc.onEvent(event);
  }
  const result = acc.result();
  assert.equal(result.stopReason, "max_tokens");
  assert.equal(result.toolUses[0]!.input, null);
  assert.equal(result.toolUses[0]!.raw, "{\"stem\": \"cut off");
  assert.deepEqual(result.content[0], { type: "tool_use", id: "t", name: "ask_question", input: {} });
  assert.match(result.error!, /overloaded_error/);
});
