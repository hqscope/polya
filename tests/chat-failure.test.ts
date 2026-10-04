import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeChatFailure,
  POLYA_CHAT_FAILED,
  POLYA_ERROR_OFFLINE,
} from "../src/lib/chat-failure.ts";
import { AI_BUSY_POLYA_TUTOR, AI_BUSY_POLYA_TUTOR_SHORT } from "../src/lib/ai-busy.ts";

test("an unknown failure gets the fixed line, never the raw text", () => {
  for (const message of [undefined, "", "TypeError: Failed to fetch", "The tutor connection dropped."]) {
    const failure = describeChatFailure({ message, questionInBox: true });
    assert.equal(failure.message, POLYA_CHAT_FAILED);
    assert.equal(failure.canRetry, true);
  }
  // An unlisted server code is treated the same way.
  assert.equal(
    describeChatFailure({ code: "not_found", message: "Course not found.", questionInBox: true }).message,
    POLYA_CHAT_FAILED,
  );
});

test("busy uses the COPY §11 line; the long one only when the question is back in the box", () => {
  assert.deepEqual(describeChatFailure({ code: "busy", questionInBox: true }), {
    message: AI_BUSY_POLYA_TUTOR,
    canRetry: true,
  });
  assert.deepEqual(describeChatFailure({ code: "busy", questionInBox: false }), {
    message: AI_BUSY_POLYA_TUTOR_SHORT,
    canRetry: true,
  });
  // Busy wins over offline and over whatever message came with it.
  assert.equal(
    describeChatFailure({ code: "busy", offline: true, message: "x", questionInBox: true }).message,
    AI_BUSY_POLYA_TUTOR,
  );
});

test("offline says so", () => {
  assert.deepEqual(describeChatFailure({ offline: true, questionInBox: true }), {
    message: POLYA_ERROR_OFFLINE,
    canRetry: true,
  });
});

test("the tutor's own guidance is shown as written", () => {
  const limited = "You're sending messages quickly. Take a short break and try again in a little while.";
  assert.deepEqual(describeChatFailure({ code: "rate_limited", message: limited, questionInBox: true }), {
    message: limited,
    canRetry: true,
  });
  assert.equal(
    describeChatFailure({ code: "unauthorized", message: "Please sign in again.", questionInBox: true }).message,
    "Please sign in again.",
  );
  // Too long can't be fixed by resending: no Try Again.
  const tooLong = describeChatFailure({
    code: "too_long",
    message: "That message is too long. Please keep it under 8,000 characters.",
    questionInBox: true,
  });
  assert.equal(tooLong.canRetry, false);
  assert.match(tooLong.message, /too long/);
  // A listed code with no message still gets the fixed line.
  assert.equal(describeChatFailure({ code: "rate_limited", message: "  ", questionInBox: true }).message, POLYA_CHAT_FAILED);
});
