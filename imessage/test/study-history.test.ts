import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clip, describeWhen, HISTORY_LIMITS, summarizeStudyHistory } from "../agent/lib/study-history.ts";

const TZ = "America/Los_Angeles";
const NOW = new Date("2026-10-15T19:00:00Z"); // Thu, Oct 15, 12:00 PM PDT

describe("describeWhen", () => {
  it("names today, yesterday, and older days in the student's time zone", () => {
    assert.equal(describeWhen(new Date("2026-10-15T16:00:00Z"), NOW, TZ), "today (Thu, Oct 15)");
    assert.equal(describeWhen(new Date("2026-10-14T20:00:00Z"), NOW, TZ), "yesterday (Wed, Oct 14)");
    assert.equal(describeWhen(new Date("2026-10-09T20:00:00Z"), NOW, TZ), "6 days ago (Fri, Oct 9)");
  });

  it("uses the local date, not the UTC date", () => {
    // 2026-10-15T05:00Z is still Oct 14 in Los Angeles.
    assert.equal(describeWhen(new Date("2026-10-15T05:00:00Z"), NOW, TZ), "yesterday (Wed, Oct 14)");
  });
});

describe("clip", () => {
  it("flattens and caps", () => {
    assert.equal(clip("  what is\n\na  pKa? ", 50), "what is a pKa?");
    assert.equal(clip("abcdefghij", 5), "abcd…");
  });
});

describe("summarizeStudyHistory", () => {
  const courses = [
    { id: "c1", name: "BIO 1A", code: null },
    { id: "c2", name: null, code: "CHEM 3A" },
  ];

  it("returns recent conversations newest first with the last few questions, oldest first", () => {
    const sessions = summarizeStudyHistory({
      conversations: [
        { id: "a", courseId: "c1", title: "Enzyme kinetics", lastMessageAt: "2026-10-09T20:00:00Z" },
        { id: "b", courseId: "c2", title: null, lastMessageAt: "2026-10-14T20:00:00Z" },
      ],
      messages: [
        { conversationId: "a", content: "q1", createdAt: "2026-10-09T18:00:00Z" },
        { conversationId: "a", content: "q2", createdAt: "2026-10-09T18:05:00Z" },
        { conversationId: "a", content: "q3", createdAt: "2026-10-09T18:10:00Z" },
        { conversationId: "a", content: "q4", createdAt: "2026-10-09T18:15:00Z" },
        { conversationId: "b", content: "What is an SN2 reaction?", createdAt: "2026-10-14T20:00:00Z" },
        { conversationId: "zzz", content: "not in a listed conversation", createdAt: "2026-10-14T20:00:00Z" },
      ],
      courses,
      now: NOW,
      timeZone: TZ,
    });

    assert.deepEqual(sessions, [
      {
        course: "CHEM 3A",
        title: "Untitled conversation",
        last_active: "yesterday (Wed, Oct 14)",
        recent_questions: ["What is an SN2 reaction?"],
      },
      {
        course: "BIO 1A",
        title: "Enzyme kinetics",
        last_active: "6 days ago (Fri, Oct 9)",
        recent_questions: ["q2", "q3", "q4"],
      },
    ]);
  });

  it("caps conversations and question length", () => {
    const conversations = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      courseId: "missing",
      title: "t",
      lastMessageAt: `2026-10-1${i}T00:00:00Z`,
    }));
    const sessions = summarizeStudyHistory({
      conversations,
      messages: [{ conversationId: "c7", content: "z".repeat(400), createdAt: "2026-10-17T00:00:00Z" }],
      courses,
      now: NOW,
      timeZone: TZ,
    });
    assert.equal(sessions.length, HISTORY_LIMITS.maxConversations);
    assert.equal(sessions[0]?.course, "Unknown course");
    assert.equal(sessions[0]?.recent_questions[0]?.length, HISTORY_LIMITS.maxQuestionChars);
  });
});
