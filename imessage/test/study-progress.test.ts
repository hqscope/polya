import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { pickNext, stagesByTopic } from "../agent/lib/study-progress.ts";

const COPY = new URL("../agent/lib/study-progress.ts", import.meta.url);
const SOURCE = new URL("../../supabase/functions/_shared/study-progress.ts", import.meta.url);
const HEADER_END = "// --- end of copy header ---\n";

describe("study progress copy", { skip: !existsSync(SOURCE) && "polya source not present" }, () => {
  it("matches polya/supabase/functions/_shared/study-progress.ts byte for byte", () => {
    const copy = readFileSync(COPY, "utf8");
    const at = copy.indexOf(HEADER_END);
    assert.ok(at >= 0, "the copy header is missing");
    assert.equal(copy.slice(at + HEADER_END.length), readFileSync(SOURCE, "utf8"));
  });
});

describe("study progress", () => {
  const topics = [
    { id: "t1", position: 0, stage: "exam_ready" },
    { id: "t2", position: 1, stage: null },
  ];
  const now = Date.parse("2026-10-21T12:00:00Z");

  it("serves an unanswered checked question, skipping coach questions and topics with none", () => {
    const step = pickNext({
      topics,
      questions: [
        { id: "q1", topic_id: "t2", status: "active", origin: "coach", created_at: "2026-10-20T00:00:00Z" },
        { id: "q2", topic_id: "t2", status: "active", origin: "bank", created_at: "2026-10-20T00:00:00Z" },
      ],
      attempts: [],
      now,
    });
    assert.deepEqual(step, { kind: "question", questionId: "q2", topicId: "t2" });
  });

  it("an exam-ready topic whose last answer was wrong needs review", () => {
    const stages = stagesByTopic(
      topics,
      [{ question_id: "q9", topic_id: "t1", score: 0, all_correct: false, created_at: "2026-10-21T10:00:00Z" }],
      now,
    );
    assert.equal(stages.get("t1")?.stage, "needs_review");
    assert.equal(stages.get("t2")?.stage, "not_started");
  });
});
