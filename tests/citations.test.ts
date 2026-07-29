import { test } from "node:test";
import assert from "node:assert/strict";

import { segmentCitations, sourceLocation, timeLabel } from "../src/lib/citations.ts";
import type { TutorSource } from "../src/lib/sse.ts";

test("segmentCitations splits text and [n] markers", () => {
  const segs = segmentCitations("Oxygen is the acceptor [1], as the lecture says [2].");
  assert.deepEqual(
    segs.map((s) => (s.kind === "cite" ? `#${s.n}` : s.text)),
    ["Oxygen is the acceptor ", "#1", ", as the lecture says ", "#2", "."],
  );
});

test("segmentCitations with no citations returns one text segment", () => {
  const segs = segmentCitations("Just prose here.");
  assert.deepEqual(segs, [{ kind: "text", text: "Just prose here." }]);
});

test("segmentCitations handles a leading citation", () => {
  const segs = segmentCitations("[3] starts it");
  assert.equal(segs[0]!.kind, "cite");
  assert.equal(segs[1]!.kind, "text");
});

test("timeLabel formats milliseconds as m:ss", () => {
  assert.equal(timeLabel(0), "0:00");
  assert.equal(timeLabel(83_000), "1:23");
  assert.equal(timeLabel(812_000), "13:32");
  assert.equal(timeLabel(null), null);
});

function source(overrides: Partial<TutorSource>): TutorSource {
  return {
    n: 1,
    unit_id: "u",
    source_id: "s",
    title: "T",
    unit_type: "chunk",
    page_start: null,
    page_end: null,
    t_start_ms: null,
    t_end_ms: null,
    snippet: "",
    ...overrides,
  } as TutorSource;
}

test("sourceLocation only claims locations it can actually open", () => {
  // Timed transcript → time range; untimed content → honest "passage" labels.
  assert.equal(sourceLocation(source({ t_start_ms: 60_000, t_end_ms: 90_000 })), "1:00–1:30");
  assert.equal(sourceLocation(source({ page_start: 14 })), "p.14");
  assert.equal(sourceLocation(source({ unit_type: "chunk" })), "passage");
  assert.equal(sourceLocation(source({ unit_type: "transcript_segment" })), "transcript passage");
  assert.equal(sourceLocation(source({ unit_type: "procedure" })), "method");
});
