import { test } from "node:test";
import assert from "node:assert/strict";

import { createSSEDecoder, type SSEEvent } from "../src/lib/sse-parse.ts";

const STREAM =
  'event: sources\ndata: {"sources":[],"conversation_id":"c1"}\n\n' +
  'event: delta\ndata: {"text":"Hello, λ world"}\n\n' +
  'event: done\ndata: {"message_id":"m1"}\n\n';

const EXPECTED: SSEEvent[] = [
  { event: "sources", data: { sources: [], conversation_id: "c1" } },
  { event: "delta", data: { text: "Hello, λ world" } },
  { event: "done", data: { message_id: "m1" } },
];

function decodeAll(chunks: string[]): SSEEvent[] {
  const decoder = createSSEDecoder();
  return chunks.flatMap((chunk) => decoder.push(chunk));
}

test("a whole stream decodes into its events", () => {
  assert.deepEqual(decodeAll([STREAM]), EXPECTED);
});

test("splitting the stream at any position gives the same events", () => {
  for (let at = 0; at <= STREAM.length; at++) {
    assert.deepEqual(decodeAll([STREAM.slice(0, at), STREAM.slice(at)]), EXPECTED, `split at ${at}`);
  }
});

test("CRLF and CR line endings, including a CRLF split across chunks", () => {
  const crlf = STREAM.replace(/\n/g, "\r\n");
  assert.deepEqual(decodeAll([crlf]), EXPECTED);
  for (let at = 0; at <= crlf.length; at++) {
    assert.deepEqual(decodeAll([crlf.slice(0, at), crlf.slice(at)]), EXPECTED, `split at ${at}`);
  }
  assert.deepEqual(decodeAll([STREAM.replace(/\n/g, "\r")]), EXPECTED);
});

test("one char at a time still works", () => {
  assert.deepEqual(decodeAll([...STREAM]), EXPECTED);
});

test("multi-line data joins with newlines; comments, id and retry are ignored", () => {
  const stream = ': keep-alive\nid: 7\nretry: 1000\nevent: block\ndata: {"a":\ndata: 1}\n\n';
  assert.deepEqual(decodeAll([stream]), [{ event: "block", data: { a: 1 } }]);
});

test("event: and data: work without the space after the colon", () => {
  assert.deepEqual(decodeAll(['event:delta\ndata:{"text":"x"}\n\n']), [{ event: "delta", data: { text: "x" } }]);
});

test("an event without a name is a message event", () => {
  assert.deepEqual(decodeAll(['data: {"ok":true}\n\n']), [{ event: "message", data: { ok: true } }]);
});

test("malformed JSON is dropped and the stream carries on", () => {
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const events = decodeAll(['event: delta\ndata: {"text":\n\n', 'event: done\ndata: {"message_id":null}\n\n']);
    assert.deepEqual(events, [{ event: "done", data: { message_id: null } }]);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = warn;
  }
});

test("an event isn't dispatched until its blank line arrives", () => {
  const decoder = createSSEDecoder();
  assert.deepEqual(decoder.push('event: delta\ndata: {"text":"a"}\n'), []);
  assert.deepEqual(decoder.push("\n"), [{ event: "delta", data: { text: "a" } }]);
  // A blank line with no data dispatches nothing.
  assert.deepEqual(decoder.push("event: ping\n\n"), []);
});
