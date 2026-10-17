import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appendBlock,
  appendDelta,
  applyCoachBlock,
  eventLabel,
  gradedFromRows,
  latestPlanKey,
  latestReplies,
  questionIdsIn,
  toCoachMessages,
  togglePlanItem,
  type CoachMessage,
  type RailState,
} from "../src/lib/coach.ts";
import {
  draftsFromResponses,
  emptyDraft,
  partsReady,
  responsesFromDrafts,
  scoreLabel,
  STAGE_CLASS,
  STAGE_LABEL,
} from "../src/lib/study.ts";
import { MASTERY_STAGES } from "../supabase/functions/_shared/study-progress.ts";

const question = (id: string) => ({
  type: "block" as const,
  block: { type: "question" as const, question: { id, stem: "S", parts: [{ kind: "numeric" as const, prompt: "P" }], difficulty: 2 as const, hide_topic: false } },
});

test("stored rows become a thread: text and cards in order, clicks as small lines, opening hidden", () => {
  const messages = toCoachMessages([
    { id: "1", role: "user", content: "(Opened the exam coach.)", sources: [], blocks: null, meta: { kind: "open" } },
    {
      id: "2",
      role: "assistant",
      content: "Welcome",
      sources: [{ n: 1 }],
      blocks: [{ type: "text", text: "Welcome" }, question("q1"), { type: "block", block: { type: "bogus" } }],
      meta: { kind: "turn" },
    },
    {
      id: "3",
      role: "user",
      content: "(Answered…)",
      sources: [],
      blocks: null,
      meta: { kind: "attempt", attempt_id: "a", question_id: "q1", right: 1, total: 2 },
    },
    { id: "4", role: "user", content: "What about Poisson?", sources: [], blocks: null, meta: null },
    { id: "5", role: "assistant", content: "Plain old answer", sources: null, blocks: null, meta: null },
  ]);
  assert.deepEqual(messages.map((m) => m.kind), ["assistant", "event", "user", "assistant"]);
  const first = messages[0] as Extract<CoachMessage, { kind: "assistant" }>;
  assert.deepEqual(first.segments.map((s) => s.type), ["text", "block"]);
  assert.equal((messages[1] as { label: string }).label, "You answered a question · 1 of 2 right");
  assert.deepEqual((messages[3] as Extract<CoachMessage, { kind: "assistant" }>).segments, [{ type: "text", text: "Plain old answer" }]);
  assert.deepEqual(questionIdsIn(messages), ["q1"]);
});

test("streamed text joins the last text segment; a card starts a new one", () => {
  let segments = appendDelta([], "Hel");
  segments = appendDelta(segments, "lo");
  segments = appendBlock(segments, { type: "replies", replies: ["Next"] });
  segments = appendDelta(segments, "After");
  assert.deepEqual(segments, [
    { type: "text", text: "Hello" },
    { type: "block", block: { type: "replies", replies: ["Next"] } },
    { type: "text", text: "After" },
  ]);
});

test("quick replies only from the newest finished turn; only the newest plan is live", () => {
  const plan = { type: "plan" as const, plan: { days: [], note: "" }, updated_at: "" };
  const messages: CoachMessage[] = [
    { localId: "a", kind: "assistant", sources: [], segments: [{ type: "block", block: plan }, { type: "block", block: { type: "replies", replies: ["Old"] } }] },
    { localId: "b", kind: "user", text: "hi" },
    { localId: "c", kind: "assistant", sources: [], segments: [{ type: "block", block: plan }, { type: "block", block: { type: "replies", replies: ["New"] } }] },
  ];
  assert.deepEqual(latestReplies(messages), ["New"]);
  assert.deepEqual(latestReplies([...messages, { localId: "d", kind: "user", text: "x" }]), []);
  assert.deepEqual(latestReplies([{ ...(messages[2] as Extract<CoachMessage, { kind: "assistant" }>), streaming: true }]), []);
  assert.equal(latestPlanKey(messages), "c:0");
});

test("the rail follows the coach: plan, stages, mistakes and mock exams", () => {
  const rail: RailState = {
    plan: null,
    topics: [{ id: "t1", position: 0, title: "Chebyshev", summary: null, key_formulas: [], source_ids: [], origin: "proposed", stage: null }],
    errors: [],
    mocks: [],
  };
  let next = applyCoachBlock(rail, { type: "stage", topic_id: "t1", title: "Chebyshev", stage: "practicing", note: "" });
  assert.equal(next.topics[0]!.stage, "practicing");
  const error = { id: "e1", topic_id: "t1", question_id: null, what: "x", why: "", fix: "", created_at: "" };
  next = applyCoachBlock(next, { type: "error_logged", error });
  next = applyCoachBlock(next, { type: "error_logged", error });
  assert.equal(next.errors.length, 1);
  next = applyCoachBlock(next, { type: "mock", mock: { id: "m1", title: "Mock", minutes: 50, question_count: 6 } });
  assert.equal(next.mocks[0]!.status, "building");
  const plan = { days: [{ date: "2026-10-20", focus: "f", items: [{ id: "i1", topic_id: null, text: "a", done: false }] }], note: "" };
  next = applyCoachBlock(next, { type: "plan", plan, updated_at: "" });
  assert.equal(togglePlanItem(next.plan!, "i1", true).days[0]!.items[0]!.done, true);
  assert.equal(next.plan!.days[0]!.items[0]!.done, false, "toggling returns a new plan");
});

test("graded cards come back from the latest attempt and its key", () => {
  const cards = gradedFromRows(
    [
      { question_id: "q1", responses: [{ kind: "numeric", answer: "1" }], results: [{ ok: true, correct: false }], score: 0, all_correct: false, created_at: "2026-10-20T10:00:00Z" },
      { question_id: "q1", responses: [{ kind: "numeric", answer: "2" }], results: [{ ok: true, correct: true }], score: 1, all_correct: true, created_at: "2026-10-20T11:00:00Z" },
      { question_id: "q2", responses: [], results: [], score: 0, all_correct: false, created_at: "2026-10-20T11:00:00Z" },
    ],
    [{ question_id: "q1", answers: [{ kind: "numeric", expr: "2", value: 2 }], explanation: "Because." }],
    () => [],
  );
  assert.equal(cards.size, 1, "no key, no card");
  assert.deepEqual(cards.get("q1")!.responses, [{ kind: "numeric", answer: "2" }]);
  assert.equal(cards.get("q1")!.graded.all_correct, true);
});

test("event lines say what happened, never how", () => {
  assert.equal(eventLabel({ kind: "open" }), null);
  assert.equal(
    eventLabel({ kind: "attempt", attempt_id: "a", question_id: "q", right: 1, total: 2, earned: 5, possible: 7 }),
    "You answered a question · 5 of 7 points",
  );
  assert.equal(eventLabel({ kind: "mock_submitted", mock_id: "m", title: "Mock midterm", pct: 78.4 }), "You handed in Mock midterm · 78%");
});

test("answer drafts round-trip, written parts must be filled, scores read naturally", () => {
  const parts = [
    { kind: "numeric" as const, prompt: "a" },
    { kind: "mc" as const, prompt: "b", options: ["x", "y"] },
    { kind: "select_all" as const, prompt: "c", options: ["x", "y"] },
    { kind: "free_response" as const, prompt: "d", points: 4 },
  ];
  const drafts = [
    { ...emptyDraft(), numeric: "0.5" },
    { ...emptyDraft(), mc: 1 },
    { ...emptyDraft(), select: [1, 0] },
    { ...emptyDraft(), text: "" },
  ];
  assert.equal(partsReady(parts, drafts), false);
  drafts[3]!.text = "Because.";
  assert.equal(partsReady(parts, drafts), true);
  const responses = responsesFromDrafts(parts, drafts);
  assert.deepEqual(responses[2], { kind: "select_all", choices: [0, 1] });
  assert.deepEqual(draftsFromResponses(parts, responses)[3]!.text, "Because.");
  assert.equal(
    scoreLabel(parts, [
      { ok: true, correct: true },
      { ok: true, correct: false },
      { ok: true, correct: true },
      { ok: true, correct: false, awarded: 3, points: 4 },
    ]),
    "5 of 7 points",
  );
  assert.equal(scoreLabel(parts.slice(0, 2), [{ ok: true, correct: true }, { ok: true, correct: false }]), "1 of 2 right");
  for (const stage of MASTERY_STAGES) {
    assert.ok(STAGE_LABEL[stage] && STAGE_CLASS[stage], stage);
  }
});
