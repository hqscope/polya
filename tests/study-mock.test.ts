import { test } from "node:test";
import assert from "node:assert/strict";

import {
  biggestDeficit,
  buildMockReport,
  mockTargets,
  pickMockQuestions,
  validateMockSpec,
  type BankQuestion,
  type MockSpec,
} from "../supabase/functions/_shared/study-mock.ts";
import { STUDY_MAX_BODY_BYTES } from "../supabase/functions/_shared/polya-rate-limits.ts";

const spec = (count: number, weights: Record<string, number>): MockSpec => ({
  question_count: count,
  topic_weights: weights,
  free_response: false,
});

test("specs are checked against the exam's topics", () => {
  assert.ok(validateMockSpec({ question_count: 8, topic_weights: { a: 2, b: 1 } }, ["a", "b"]).ok);
  assert.equal(validateMockSpec({ question_count: 2, topic_weights: { a: 1 } }, ["a"]).ok, false);
  assert.equal(validateMockSpec({ question_count: 8, topic_weights: { z: 1 } }, ["a"]).ok, false);
  assert.equal(validateMockSpec({ question_count: 8, topic_weights: { a: 9 } }, ["a"]).ok, false);
  assert.equal(validateMockSpec({ question_count: 8, topic_weights: {} }, ["a"]).ok, false);
});

test("questions are spread by weight and always add up", () => {
  assert.deepEqual([...mockTargets(spec(8, { a: 2, b: 1, c: 1 }))], [["a", 4], ["b", 2], ["c", 2]]);
  assert.deepEqual([...mockTargets(spec(3, { a: 1, b: 1, c: 1, d: 1 }))].map(([, n]) => n).reduce((x, y) => x + y), 3);
  assert.deepEqual([...mockTargets(spec(5, { a: 5, b: 1 }))], [["a", 4], ["b", 1]]);
});

const q = (id: string, topic_id: string, over: Partial<BankQuestion> = {}): BankQuestion => ({
  id,
  topic_id,
  status: "active",
  origin: "bank",
  created_at: `2026-10-0${id.length}T00:00:00Z`,
  ...over,
});

test("only fresh, checked questions are picked; shortfalls are reported", () => {
  const bank = [
    q("a1", "a"),
    q("a2", "a", { origin: "coach" }),
    q("a3", "a", { status: "flagged" }),
    q("a4", "a"),
    q("a5", "a"),
    q("b1", "b"),
    q("b2", "b"),
  ];
  const result = pickMockQuestions({
    spec: spec(6, { a: 2, b: 1 }),
    have: [],
    bank,
    attemptedIds: new Set(["a4"]),
    reservedIds: new Set(["b2"]),
  });
  assert.deepEqual(result.chosen, ["a1", "a5", "b1"]);
  assert.deepEqual([...result.deficits], [["a", 2], ["b", 1]]);
  assert.equal(biggestDeficit(result.deficits, spec(6, { a: 2, b: 1 })), "a");

  const next = pickMockQuestions({ spec: spec(6, { a: 2, b: 1 }), have: result.chosen, bank, attemptedIds: new Set(), reservedIds: new Set() });
  assert.deepEqual(next.chosen, ["a4", "b2"]);
});

test("the report scores by topic, weakest first, and records overtime", () => {
  const report = buildMockReport({
    results: [
      { question_id: "1", topic_id: "a", score: 1, all_correct: true },
      { question_id: "2", topic_id: "a", score: 0.5, all_correct: false },
      { question_id: "3", topic_id: "b", topic_ids: ["b", "a"], score: 0, all_correct: false },
    ],
    topics: [{ id: "a", title: "Indicators" }, { id: "b", title: "Chebyshev" }],
    startedAt: "2026-10-20T10:00:00Z",
    dueAt: "2026-10-20T11:00:00Z",
    submittedAt: "2026-10-20T11:02:00Z",
  });
  assert.equal(report.score, 0.5);
  assert.equal(report.earned, 1.5);
  assert.equal(report.possible, 3);
  assert.deepEqual(report.per_topic.map((t) => [t.title, t.earned, t.possible]), [["Chebyshev", 0, 1], ["Indicators", 1.5, 3]]);
  assert.deepEqual(report.missed, ["2", "3"]);
  assert.equal(report.minutes_used, 62);
  assert.equal(report.overtime_seconds, 90);
});

test("a full 12-question mock with long written answers fits the request cap", () => {
  const answers = Array.from({ length: 12 }, (_, i) => ({
    question_id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
    responses: Array.from({ length: 4 }, () => ({ kind: "free_response", text: "x".repeat(1_000) })),
  }));
  const bytes = new TextEncoder().encode(JSON.stringify({ action: "submit_mock", mock_id: answers[0]!.question_id, answers })).length;
  assert.ok(bytes < STUDY_MAX_BODY_BYTES, `${bytes} bytes`);
});
