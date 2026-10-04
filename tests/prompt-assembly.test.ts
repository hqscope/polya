import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSources,
  buildSystemBlocks,
  buildUserTurn,
  classifyIntent,
  evidenceBlock,
  normalizeLectureContext,
  turnStateBlock,
} from "../supabase/functions/_shared/prompts.ts";
import type { RetrievedUnit } from "../supabase/functions/_shared/retrieval-types.ts";

const units: RetrievedUnit[] = [
  {
    unit_id: "u1",
    source_id: "s1",
    unit_type: "chunk",
    content_role: "material",
    ordinal: 0,
    heading_path: null,
    page_start: 3,
    page_end: 3,
    t_start_ms: null,
    t_end_ms: null,
    procedure_id: null,
    step_number: null,
    title: "Lecture 7",
    content: "Bayes rule states that",
    score: 0.9,
  },
];

const base = {
  intent: classifyIntent("how do I solve part b"),
  mode: "guided" as const,
  masteryBlock: "",
  sources: buildSources(units),
  units,
  message: "how do I solve part b",
};

// The cache contract: two cached breakpoints, and nothing per-turn may join them.
test("system blocks are exactly the two cached blocks", () => {
  const blocks = buildSystemBlocks("Data 100", "guided", null);
  assert.equal(blocks.length, 2, "a third system block would spend a cache breakpoint every turn");
  for (const block of blocks) {
    assert.deepEqual(block.cache_control, { type: "ephemeral" });
  }
});

test("lecture context is not an input to the cached blocks", () => {
  const a = buildSystemBlocks("Data 100", "guided", null);
  const b = buildSystemBlocks("Data 100", "guided", null);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // Arity is the guard: if someone threads the live window through here, the
  // cached prefix would change per turn and this fails loudly.
  assert.equal(buildSystemBlocks.length, 3);
});

test("with no lecture context the user turn is byte-identical to the legacy format", () => {
  const legacy = `${turnStateBlock(base.intent, base.mode)}\n\n${evidenceBlock(base.sources, base.units)}\n\nStudent message: ${base.message}`;
  assert.equal(buildUserTurn({ ...base, lecture: null }), legacy);
});

test("the room is read before the course, and the question comes last", () => {
  const turn = buildUserTurn({
    ...base,
    lecture: normalizeLectureContext({ typed: "P(A|B) = ..." }),
  });
  const lecture = turn.indexOf("<lecture_context>");
  const evidence = turn.indexOf("<course_evidence>");
  const message = turn.indexOf("Student message:");
  assert.ok(lecture > -1, "lecture block present");
  assert.ok(lecture < evidence, "lecture context before course evidence");
  assert.ok(evidence < message, "course evidence before the student message");
  assert.ok(turn.indexOf("Turn state:") < lecture, "turn state first");
});

test("a mastery block still precedes the lecture context", () => {
  const turn = buildUserTurn({
    ...base,
    masteryBlock: "\n\nMASTERY CHECK - judging the attempt.",
    lecture: normalizeLectureContext({ transcript: "he just said" }),
  });
  assert.ok(turn.indexOf("MASTERY CHECK") < turn.indexOf("<lecture_context>"));
});
