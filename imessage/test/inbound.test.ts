import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  capDecision,
  capReachedMessage,
  checkSender,
  dailyReplyCap,
  DEFAULT_DAILY_REPLY_CAP,
  decideLink,
  hostOf,
  isDirectThreadId,
  linkMessage,
  linkPendingMessage,
  shouldIssueCode,
  unavailableMessage,
} from "../agent/lib/inbound.ts";
import { MAX_OPEN_CODES_PER_HANDLE } from "../agent/lib/link.ts";

const STUDENT = "11111111-1111-4111-8111-111111111111";
const DM_THREAD = "imessage:iMessage;-;+16615550100";
const GROUP_THREAD = "imessage:iMessage;+;chat123456789";

describe("checkSender", () => {
  it("ignores our own messages and bots", () => {
    assert.deepEqual(checkSender({ userId: "+16615550100", isMe: true }, true), { kind: "ignore", reason: "own-message" });
    assert.deepEqual(checkSender({ userId: "+16615550100", isBot: true }, true), { kind: "ignore", reason: "bot" });
  });

  it("ignores group chats", () => {
    assert.deepEqual(checkSender({ userId: "+16615550100" }, false), { kind: "ignore", reason: "group-chat" });
  });

  it("ignores handles it can't normalize", () => {
    assert.deepEqual(checkSender({ userId: "not a handle" }, true), { kind: "ignore", reason: "unknown-handle" });
  });

  it("normalizes phone and email senders", () => {
    assert.deepEqual(checkSender({ userId: "(661) 555-0100", isMe: false, isBot: false }, true), {
      kind: "sender",
      handle: "+16615550100",
    });
    assert.deepEqual(checkSender({ userId: "Student@Berkeley.EDU", isBot: "unknown" }, true), {
      kind: "sender",
      handle: "student@berkeley.edu",
    });
  });
});

describe("isDirectThreadId", () => {
  it("tells one-to-one chats from group chats", () => {
    assert.equal(isDirectThreadId(DM_THREAD), true);
    assert.equal(isDirectThreadId(GROUP_THREAD), false);
  });
});

describe("decideLink", () => {
  it("asks for a link when the handle isn't linked", () => {
    assert.deepEqual(decideLink(null, DM_THREAD), { kind: "needs-link" });
  });

  it("dispatches a linked student and saves a missing thread", () => {
    assert.deepEqual(decideLink({ user_id: STUDENT, thread_id: null, timezone: "America/New_York" }, DM_THREAD), {
      kind: "dispatch",
      userId: STUDENT,
      timezone: "America/New_York",
      saveThreadId: true,
    });
  });

  it("doesn't rewrite a thread it already has", () => {
    const decision = decideLink({ user_id: STUDENT, thread_id: DM_THREAD, timezone: "America/Los_Angeles" }, DM_THREAD);
    assert.equal(decision.kind === "dispatch" && decision.saveThreadId, false);
  });

  it("saves a thread that changed", () => {
    const decision = decideLink({ user_id: STUDENT, thread_id: "imessage:old", timezone: "America/Los_Angeles" }, DM_THREAD);
    assert.equal(decision.kind === "dispatch" && decision.saveThreadId, true);
  });
});

describe("shouldIssueCode", () => {
  it("stops minting codes once a handle holds enough live ones", () => {
    assert.equal(shouldIssueCode(0), true);
    assert.equal(shouldIssueCode(MAX_OPEN_CODES_PER_HANDLE - 1), true);
    assert.equal(shouldIssueCode(MAX_OPEN_CODES_PER_HANDLE), false);
  });
});

describe("daily reply cap", () => {
  it("reads a positive integer from the environment, else the default", () => {
    assert.equal(dailyReplyCap({}), DEFAULT_DAILY_REPLY_CAP);
    assert.equal(DEFAULT_DAILY_REPLY_CAP, 60);
    assert.equal(dailyReplyCap({ POLYA_IMESSAGE_DAILY_REPLY_CAP: "25" }), 25);
    assert.equal(dailyReplyCap({ POLYA_IMESSAGE_DAILY_REPLY_CAP: " 25 " }), 25);
    for (const bad of ["0", "-5", "abc", "2.5", ""]) {
      assert.equal(dailyReplyCap({ POLYA_IMESSAGE_DAILY_REPLY_CAP: bad }), DEFAULT_DAILY_REPLY_CAP, bad);
    }
  });

  it("allows up to the cap, notifies once past it, then goes quiet", () => {
    assert.equal(capDecision(1, 3), "allow");
    assert.equal(capDecision(3, 3), "allow");
    assert.equal(capDecision(4, 3), "notify");
    assert.equal(capDecision(5, 3), "silent");
  });

  it("refuses when the meter fails", () => {
    assert.equal(capDecision(null, 3), "unavailable");
  });
});

describe("fixed replies", () => {
  const MECHANICS = /\b(model|webhook|eve|photon|supabase|service role|rag|embedding|database|api)\b/i;
  const MARKDOWN = /[*#`]|\[[^\]]*\]\(/;

  it("puts the link in the link message and keeps all copy plain", () => {
    const url = "https://askpolya.com/connect/imessage?code=abc";
    const messages = [linkMessage(url), linkPendingMessage(), capReachedMessage(5, "askpolya.com"), unavailableMessage()];
    assert.ok(messages[0]?.includes(url));
    assert.ok(messages[0]?.includes("15 minutes"));
    for (const message of messages) {
      assert.doesNotMatch(message.replace(url, ""), MECHANICS, message);
      assert.doesNotMatch(message.replace(url, ""), MARKDOWN, message);
    }
  });

  it("says when the cap resets", () => {
    assert.match(capReachedMessage(5, "askpolya.com"), /in about 5 hours/);
    assert.match(capReachedMessage(1, "askpolya.com"), /in about an hour/);
  });

  it("shows the app host without the scheme", () => {
    assert.equal(hostOf("https://askpolya.com/"), "askpolya.com");
    assert.equal(hostOf("http://localhost:3000"), "localhost:3000");
  });
});
