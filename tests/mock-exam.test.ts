import { test } from "node:test";
import assert from "node:assert/strict";

import {
  answeredCount,
  emptyMockDraft,
  formatPoints,
  formatRemaining,
  mockDraftKey,
  parseMockDraft,
  remainingMs,
  topicAdvice,
  unfinishedNotice,
  warningCrossed,
  type MockQuestion,
} from "../src/lib/mock-exam.ts";

const questions: MockQuestion[] = [
  { id: "q1", stem: "S1", parts: [{ kind: "numeric", prompt: "a" }, { kind: "mc", prompt: "b", options: ["x", "y", "z"] }] },
  { id: "q2", stem: "S2", parts: [{ kind: "select_all", prompt: "c", options: ["p", "q"] }] },
  { id: "q3", stem: "S3", parts: [{ kind: "free_response", prompt: "d", points: 4 }] },
];

test("the clock counts down from the server's due time, corrected for this device", () => {
  const due = "2026-10-20T11:00:00.000Z";
  const now = Date.parse("2026-10-20T10:55:00.000Z");
  assert.equal(remainingMs(due, 0, now), 5 * 60_000);
  // This device runs 30 s slow: the server is 30 s ahead.
  assert.equal(remainingMs(due, 30_000, now), 4.5 * 60_000);
  assert.equal(remainingMs(due, 0, Date.parse("2026-10-20T11:01:00.000Z")), 0);
  assert.equal(remainingMs("not a date", 0, now), 0);
});

test("remaining time reads as m:ss or h:mm:ss, rounding up", () => {
  assert.equal(formatRemaining(0), "0:00");
  assert.equal(formatRemaining(999), "0:01");
  assert.equal(formatRemaining(65_000), "1:05");
  assert.equal(formatRemaining(59 * 60_000 + 59_000), "59:59");
  assert.equal(formatRemaining(3_729_000), "1:02:09");
  assert.equal(formatRemaining(-5), "0:00");
});

test("warnings fire once, as the clock crosses 5 minutes and 1 minute", () => {
  assert.equal(warningCrossed(5 * 60_000 + 500, 5 * 60_000), "5 minutes left");
  assert.equal(warningCrossed(5 * 60_000, 4 * 60_000), null);
  assert.equal(warningCrossed(61_000, 60_000), "1 minute left");
  // A tab that slept past both thresholds gets the more urgent one.
  assert.equal(warningCrossed(10 * 60_000, 30_000), "1 minute left");
  assert.equal(warningCrossed(30_000, 0), null);
});

test("answered and blank questions are counted for the navigator and the hand-in check", () => {
  const draft = emptyMockDraft(questions);
  assert.equal(answeredCount(questions, draft), 0, "an untouched select-all counts as blank");
  assert.equal(unfinishedNotice(questions, draft), "You've left 3 questions blank.");
  draft.answers.q1![0]!.numeric = "0.5";
  assert.equal(unfinishedNotice(questions, draft), "You've left 2 questions blank and 1 unfinished.");
  draft.answers.q1![1]!.mc = 2;
  draft.answers.q3![0]!.text = "Because…";
  assert.equal(answeredCount(questions, draft), 2);
  assert.equal(unfinishedNotice(questions, draft), "You've left 1 question blank.");
  draft.answers.q2![0]!.select = [0];
  assert.equal(answeredCount(questions, draft), 3);
  assert.equal(unfinishedNotice(questions, draft), null);
});

test("saved answers are read back strictly", () => {
  const saved = JSON.stringify({
    answers: {
      q1: [{ numeric: "1/2", mc: 7 }, { mc: 1 }],
      q2: [{ select: [1, 1, 5, -1, "x"] }],
      q3: "nonsense",
      stale: [{ numeric: "9" }],
    },
    flagged: ["q2", "gone", 4],
    current: 9,
  });
  const draft = parseMockDraft(saved, questions);
  assert.equal(draft.answers.q1![0]!.numeric, "1/2");
  assert.equal(draft.answers.q1![0]!.mc, null, "a numeric part keeps no choice");
  assert.equal(draft.answers.q1![1]!.mc, 1);
  assert.deepEqual(draft.answers.q2![0]!.select, [1]);
  assert.equal(draft.answers.q3![0]!.text, "");
  assert.equal("stale" in draft.answers, false);
  assert.deepEqual(draft.flagged, ["q2"]);
  assert.equal(draft.current, 2);

  assert.deepEqual(parseMockDraft("{not json", questions), emptyMockDraft(questions));
  assert.deepEqual(parseMockDraft(null, questions), emptyMockDraft(questions));
  assert.deepEqual(parseMockDraft("[1,2]", questions), emptyMockDraft(questions));
});

test("keys, advice and points", () => {
  assert.equal(mockDraftKey("u1", "m1"), "polya:mock:u1:m1");
  assert.match(topicAdvice(0.9), /^Solid/);
  assert.match(topicAdvice(0.6), /^Close/);
  assert.match(topicAdvice(0.3), /^Shaky/);
  assert.match(topicAdvice(0), /^Start here/);
  assert.equal(formatPoints(7.754), "7.75");
  assert.equal(formatPoints(8), "8");
});
