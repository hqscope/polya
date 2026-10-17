import { test } from "node:test";
import assert from "node:assert/strict";

import {
  pickNext,
  RETRY_AFTER_MS,
  topicProgress,
  type ProgressAttempt,
  type ProgressQuestion,
} from "../supabase/functions/_shared/study-progress.ts";
import { buildPracticeSeed, PRACTICE_SEED_MAX_CHARS } from "../supabase/functions/_shared/study-seed.ts";

const NOW = Date.parse("2026-12-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;

function attempt(question_id: string, topic_id: string, score: number, at: string): ProgressAttempt {
  return { question_id, topic_id, score, all_correct: score === 1, created_at: at };
}
function question(id: string, topic_id: string, at = ago(48 * HOUR), status = "active"): ProgressQuestion {
  return { id, topic_id, status, created_at: at };
}

test("topic status follows recent accuracy", () => {
  assert.deepEqual(topicProgress([]), { status: "not_started", attempts: 0, accuracy: null });
  assert.equal(topicProgress([attempt("q", "t", 0, ago(1)), attempt("q", "t", 0.5, ago(2))]).status, "shaky");
  assert.equal(topicProgress([attempt("q", "t", 1, ago(1)), attempt("q", "t", 1, ago(2))]).status, "getting_there", "2 is too few to be solid");
  assert.equal(
    topicProgress([attempt("a", "t", 1, ago(1)), attempt("b", "t", 0.5, ago(2)), attempt("c", "t", 0.5, ago(3))]).status,
    "getting_there",
  );
  assert.equal(
    topicProgress([attempt("a", "t", 1, ago(1)), attempt("b", "t", 1, ago(2)), attempt("c", "t", 1, ago(3))]).status,
    "solid",
  );
  // Only the latest six count: early misses age out.
  const recovered = [
    ...Array.from({ length: 6 }, (_, i) => attempt(`n${i}`, "t", 1, ago(i + 1))),
    ...Array.from({ length: 6 }, (_, i) => attempt(`o${i}`, "t", 0, ago(100 + i))),
  ];
  assert.equal(topicProgress(recovered).status, "solid");
});

const topics = [
  { id: "t1", position: 0 },
  { id: "t2", position: 1 },
  { id: "t3", position: 2 },
];

test("weak spots: the weakest topic's unanswered question comes first", () => {
  const next = pickNext({
    topics,
    questions: [question("q1", "t1"), question("q2", "t2"), question("q2b", "t2")],
    attempts: [attempt("q2", "t2", 0, ago(HOUR)), attempt("q1x", "t1", 1, ago(HOUR))],
    now: NOW,
  });
  assert.deepEqual(next, { kind: "question", questionId: "q2b", topicId: "t2" });
});

test("a missed question returns only after a day", () => {
  const base = {
    topics: [topics[0]!],
    questions: [question("q1", "t1")],
    now: NOW,
  };
  assert.deepEqual(pickNext({ ...base, attempts: [attempt("q1", "t1", 0, ago(2 * HOUR))] }), { kind: "write", topicId: "t1" });
  assert.deepEqual(pickNext({ ...base, attempts: [attempt("q1", "t1", 0, ago(RETRY_AFTER_MS))] }), {
    kind: "question",
    questionId: "q1",
    topicId: "t1",
  });
  // Got it right last time: not repeated.
  assert.deepEqual(
    pickNext({ ...base, attempts: [attempt("q1", "t1", 0, ago(3 * RETRY_AFTER_MS)), attempt("q1", "t1", 1, ago(2 * RETRY_AFTER_MS))] }),
    { kind: "write", topicId: "t1" },
  );
});

test("reported and already-shown questions are skipped; one topic can be chosen", () => {
  const questions = [question("bad", "t3", ago(3 * HOUR), "flagged"), question("seen", "t3"), question("q1", "t1")];
  assert.deepEqual(pickNext({ topics, questions, attempts: [], now: NOW, topicId: "t3", skip: new Set(["seen"]) }), {
    kind: "write",
    topicId: "t3",
  });
  assert.deepEqual(pickNext({ topics, questions, attempts: [], now: NOW, topicId: "nope" }), { kind: "none" });
  assert.deepEqual(pickNext({ topics: [], questions, attempts: [], now: NOW }), { kind: "none" });
});

test("when every topic is solid, practice still continues", () => {
  const solid = topics.flatMap((t) => [1, 2, 3].map((i) => attempt(`${t.id}-${i}`, t.id, 1, ago(i * HOUR))));
  const next = pickNext({ topics, questions: [], attempts: solid, now: NOW });
  assert.equal(next.kind, "write");
});

test("the chat seed lays out the question and the student's answers", () => {
  const seed = buildPracticeSeed({
    stem: "A fair coin is tossed 5 times.",
    parts: [
      { kind: "numeric", prompt: "P(at least two consecutive heads)?" },
      { kind: "mc", prompt: "Are the events independent?", options: ["True", "False"] },
    ],
    responses: [
      { kind: "numeric", answer: "0.264" },
      { kind: "mc", choice: 1 },
    ],
    correct: [false, true],
  });
  assert.equal(
    seed,
    [
      "I'm working on this practice question:",
      "",
      "A fair coin is tossed 5 times.",
      "",
      "Part 1: P(at least two consecutive heads)?",
      "My answer: 0.264 (wrong)",
      "",
      "Part 2: Are the events independent?",
      "A. True",
      "B. False",
      "My answer: B (right)",
      "",
      "Can you help me see where my thinking went wrong?",
    ].join("\n"),
  );
  const long = buildPracticeSeed({ stem: "x".repeat(20_000), parts: [] });
  assert.equal(long.length, PRACTICE_SEED_MAX_CHARS);
});

// ---------------------------------------------------------------------------
// Mastery stages, spaced review and mistakes (the exam coach).
// ---------------------------------------------------------------------------
import {
  canMarkExamReady,
  dueReviews,
  effectiveStage,
  errorStatus,
  progressByTopic,
  REVIEW_AFTER_MS,
  stagesByTopic,
} from "../supabase/functions/_shared/study-progress.ts";

test("a mixed question counts toward every topic it covered", () => {
  const progress = progressByTopic(
    [{ id: "a", position: 0 }, { id: "b", position: 1 }],
    [{ question_id: "q", topic_id: "a", topic_ids: ["a", "b"], score: 1, all_correct: true, created_at: ago(HOUR) }],
  );
  assert.equal(progress.get("a")!.attempts, 1);
  assert.equal(progress.get("b")!.attempts, 1);
});

test("practice never serves questions the coach wrote mid-conversation", () => {
  const next = pickNext({
    topics: [{ id: "a", position: 0 }],
    questions: [{ ...question("coach-q", "a"), origin: "coach" }, question("bank-q", "a")],
    attempts: [],
    now: NOW,
  });
  assert.deepEqual(next, { kind: "question", questionId: "bank-q", topicId: "a" });
});

test("stages: stored ones hold, exam-ready slips to needs review after a miss or time away", () => {
  const solid = topicProgress([attempt("1", "a", 1, ago(HOUR)), attempt("2", "a", 1, ago(HOUR)), attempt("3", "a", 1, ago(HOUR))]);
  assert.equal(canMarkExamReady(solid), true);
  assert.equal(canMarkExamReady(topicProgress([attempt("1", "a", 1, ago(HOUR))])), false);

  const right = { created_at: ago(HOUR), all_correct: true };
  assert.equal(effectiveStage({ stored: "exam_ready", progress: solid, lastAttempt: right, now: NOW }), "exam_ready");
  assert.equal(effectiveStage({ stored: "exam_ready", progress: solid, lastAttempt: { ...right, all_correct: false }, now: NOW }), "needs_review");
  assert.equal(
    effectiveStage({ stored: "exam_ready", progress: solid, lastAttempt: { ...right, created_at: ago(REVIEW_AFTER_MS + HOUR) }, now: NOW }),
    "needs_review",
  );
  assert.equal(effectiveStage({ stored: "learning", progress: solid, lastAttempt: right, now: NOW }), "learning");
  assert.equal(effectiveStage({ stored: null, progress: topicProgress([]), lastAttempt: null, now: NOW }), "not_started");
  assert.equal(effectiveStage({ stored: null, progress: solid, lastAttempt: right, now: NOW }), "practicing");
});

test("due reviews: slipped topics and old misses, oldest first", () => {
  const topics = [{ id: "a", position: 0, stage: "exam_ready" }, { id: "b", position: 1, stage: "practicing" }];
  const attempts = [
    attempt("q1", "a", 0, ago(2 * HOUR)),
    attempt("q2", "b", 0, ago(30 * HOUR)),
    attempt("q3", "b", 0, ago(50 * HOUR)),
    attempt("q4", "b", 1, ago(60 * HOUR)),
  ];
  assert.equal(stagesByTopic(topics, attempts, NOW).get("a")!.stage, "needs_review");
  assert.deepEqual(dueReviews({ topics, attempts, now: NOW }), { topicIds: ["a"], questionIds: ["q3", "q2"] });
});

test("a logged mistake is fixed by a later fully right answer on its topic", () => {
  const errors = [
    { id: "e1", topic_id: "a", created_at: ago(10 * HOUR) },
    { id: "e2", topic_id: "b", created_at: ago(10 * HOUR) },
    { id: "e3", topic_id: null, created_at: ago(10 * HOUR) },
  ];
  const status = errorStatus(errors, [attempt("q", "a", 1, ago(HOUR)), attempt("r", "b", 1, ago(20 * HOUR))]);
  assert.deepEqual(status.map((e) => e.fixed), [true, false, false]);
});
