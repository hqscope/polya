import { test } from "node:test";
import assert from "node:assert/strict";

import {
  conversationTitle,
  RECENT_CONVERSATION_LIMIT,
  relativeTime,
  toRecentConversations,
} from "../src/lib/conversations.ts";

const now = new Date("2026-09-24T18:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const MIN = 60_000;
const HR = 60 * MIN;
const DAY = 24 * HR;

test("relative time buckets", () => {
  assert.equal(relativeTime(ago(20_000), now), "Just now");
  assert.equal(relativeTime(ago(5 * MIN), now), "5 min ago");
  assert.equal(relativeTime(ago(3 * HR + 10 * MIN), now), "3 hr ago");
  assert.equal(relativeTime(ago(DAY + HR), now), "1 day ago");
  assert.equal(relativeTime(ago(6 * DAY), now), "6 days ago");
  assert.equal(relativeTime("2026-09-03T12:00:00Z", now), "Sep 3");
  assert.equal(relativeTime("2025-12-30T12:00:00Z", now), "Dec 30, 2025");
  assert.equal(relativeTime("not a date", now), "");
});

test("titles are tidied and a cut-off question gets an ellipsis", () => {
  assert.equal(conversationTitle("  Why is   the sky blue? "), "Why is the sky blue?");
  assert.equal(conversationTitle(null), "Conversation");
  assert.equal(conversationTitle("   "), "Conversation");
  const cut = "x".repeat(60);
  const shown = conversationTitle(cut);
  assert.equal(shown.length, 60);
  assert.ok(shown.endsWith("…"));
});

test("recent list: newest first, answered only, capped at three", () => {
  const rows = [
    { id: "old", title: "Old one", last_message_at: ago(5 * DAY) },
    { id: "unanswered", title: "No reply saved", last_message_at: null },
    { id: "newest", title: "Newest", last_message_at: ago(2 * MIN) },
    { id: "mid", title: "Middle", last_message_at: ago(2 * HR) },
    { id: "older", title: "Older", last_message_at: ago(3 * DAY) },
  ];
  const recent = toRecentConversations(rows, now);
  assert.equal(RECENT_CONVERSATION_LIMIT, 3);
  assert.deepEqual(
    recent.map((c) => c.id),
    ["newest", "mid", "older"],
  );
  assert.deepEqual(recent[0], { id: "newest", title: "Newest", when: "2 min ago" });
  assert.deepEqual(toRecentConversations([], now), []);
});
