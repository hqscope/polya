import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activeLessons,
  buildFixRequest,
  canFileFixes,
  cleanText,
  type Fix,
  FIX_LIMITS,
  FixNotice,
  fixOwner,
  formatFixInstructions,
  issueRefFromUrl,
  issueUrlFromHandoff,
  planNotice,
  planShip,
} from "../agent/lib/fixes.ts";

const OWNER = "11111111-2222-3333-4444-555555555555";
const STUDENT = "99999999-8888-7777-6666-555555555555";
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const PR_URL = "https://github.com/hqscope/polya/pull/52";
const ISSUE_URL = "https://github.com/hqscope/polya/issues/41";

function fix(overrides: Partial<Fix> = {}): Fix {
  return {
    id: 3,
    lesson: "Before saying someone is waiting on a reply, check whether Noel already replied in that thread.",
    status: "filed",
    issueRef: "hqscope/polya#41",
    issueUrl: ISSUE_URL,
    prUrl: null,
    prNumber: null,
    headSha: null,
    createdAt: "2026-10-26T12:00:00Z",
    ...overrides,
  };
}

function notice(overrides: Record<string, unknown> = {}): FixNotice {
  return FixNotice.parse({ issue: "hqscope/polya#41", issue_url: ISSUE_URL, title: "Fix digest", status: "pr-ready", ...overrides });
}

const openPr = { url: PR_URL, number: 52, head_sha: SHA, merged: false };

describe("fixOwner", () => {
  it("is the owner only in the owner's own session", () => {
    assert.equal(fixOwner(OWNER, { NOEL_HUB_POLYA_USER_ID: OWNER }), OWNER);
    assert.equal(fixOwner(STUDENT, { NOEL_HUB_POLYA_USER_ID: OWNER }), null);
    assert.equal(fixOwner(undefined, { NOEL_HUB_POLYA_USER_ID: OWNER }), null);
  });

  it("is off when no owner is configured", () => {
    assert.equal(fixOwner(OWNER, {}), null);
    assert.equal(fixOwner(OWNER, { NOEL_HUB_POLYA_USER_ID: "  " }), null);
  });
});

describe("canFileFixes", () => {
  it("needs a scope-ops token", () => {
    assert.equal(canFileFixes({ SCOPE_OPS_TOKEN: "sops_abc" }), true);
    assert.equal(canFileFixes({ SCOPE_OPS_TOKEN: " " }), false);
    assert.equal(canFileFixes({}), false);
  });
});

describe("cleanText", () => {
  it("collapses whitespace and refuses empty or long text", () => {
    assert.equal(cleanText("  check\n\nfirst  ", 50), "check first");
    assert.equal(cleanText("   ", 50), null);
    assert.equal(cleanText("x".repeat(51), 50), null);
  });
});

describe("activeLessons", () => {
  const now = new Date("2026-10-27T12:00:00Z");

  it("keeps lessons whose fix isn't live or closed", () => {
    const fixes = [
      fix({ id: 1, status: "filed" }),
      fix({ id: 2, status: "pr_ready" }),
      fix({ id: 3, status: "needs_noel" }),
      fix({ id: 4, status: "failed" }),
      fix({ id: 5, status: "shipped" }),
      fix({ id: 6, status: "closed" }),
    ];
    assert.deepEqual(
      activeLessons(fixes, now).map((f) => f.id),
      [1, 2, 3, 4],
    );
  });

  it("drops lessons older than the limit", () => {
    const old = new Date(now.getTime() - (FIX_LIMITS.activeDays + 1) * 86_400_000).toISOString();
    assert.deepEqual(activeLessons([fix({ createdAt: old }), fix({ createdAt: "not a date" })], now), []);
  });
});

describe("buildFixRequest", () => {
  const built = buildFixRequest(3, {
    lesson: "Check whether Noel already replied before saying someone is waiting.",
    whatWasWrong: "I already emailed them back.",
    whatPolyaDid: "Said a sender was waiting on a reply.",
    replyingTo: "A digest item about an unread email.",
    where: "digest",
  });

  it("states the mistake, the fix, and what done looks like", () => {
    assert.match(built.request, /I already emailed them back\./);
    assert.match(built.request, /Check whether Noel already replied/);
    assert.match(built.request, /cd imessage && npm test && npm run typecheck/);
    assert.match(built.request, /## Summary/);
    assert.match(built.request, /study rules/);
  });

  it("points at the code that wrote the message and the stopgap lesson", () => {
    assert.match(built.context, /hub-digest/);
    assert.match(built.context, /A digest item about an unread email\./);
    assert.match(built.context, /lesson #3/);
  });

  it("fits scope-ops' hand-off limits even at the field maximums", () => {
    const long = buildFixRequest(999, {
      lesson: "x".repeat(FIX_LIMITS.maxLessonChars),
      whatWasWrong: "x".repeat(FIX_LIMITS.maxCaseChars),
      whatPolyaDid: "x".repeat(FIX_LIMITS.maxCaseChars),
      replyingTo: "x".repeat(FIX_LIMITS.maxCaseChars),
      where: "other",
    });
    assert.ok(long.request.length <= 8000);
    assert.ok(long.context.length <= 12000);
  });
});

describe("issue links", () => {
  it("turns an issue URL into a ref", () => {
    assert.equal(issueRefFromUrl(ISSUE_URL), "hqscope/polya#41");
    assert.equal(issueRefFromUrl(`${ISSUE_URL}#issuecomment-1`), "hqscope/polya#41");
    assert.equal(issueRefFromUrl(PR_URL), null);
    assert.equal(issueRefFromUrl("https://evil.example/hqscope/polya/issues/41"), null);
    assert.equal(issueRefFromUrl(null), null);
  });

  it("reads the issue from handoff_task's structured result, then its text", () => {
    assert.equal(issueUrlFromHandoff({ issue_url: ISSUE_URL }, ""), ISSUE_URL);
    assert.equal(issueUrlFromHandoff(null, `Handed off as hqscope/polya#41.\nIssue: ${ISSUE_URL}\nSlack: https://x.slack.com/a`), ISSUE_URL);
    assert.equal(issueUrlFromHandoff({ issue_url: "not a url" }, "nothing here"), null);
  });
});

describe("formatFixInstructions", () => {
  it("says nothing without lessons or filing", () => {
    assert.equal(formatFixInstructions([], false), null);
  });

  it("explains the loop when filing is on", () => {
    const text = formatFixInstructions([], true) ?? "";
    assert.match(text, /report_mistake/);
    assert.match(text, /ship_fix/);
    assert.match(text, /\[polya fix\]/);
    assert.doesNotMatch(text, /Lessons from/);
  });

  it("counts a digest item he already handled, and forbids unbacked promises", () => {
    const text = formatFixInstructions([], true) ?? "";
    assert.match(text, /I already replied to them/);
    assert.match(text, /even when you couldn't have known/);
    assert.match(text, /unless you call report_mistake in the same turn/);
    assert.match(text, /"#2"/);
  });

  it("lists the lessons in effect by number", () => {
    const text = formatFixInstructions([fix({ id: 3 }), fix({ id: 7, lesson: "Keep digests to one line." })], false) ?? "";
    assert.match(text, /#3: Before saying someone is waiting/);
    assert.match(text, /#7: Keep digests to one line\./);
    assert.match(text, /never loosen the study rules/);
  });
});

describe("FixNotice", () => {
  it("accepts scope-ops' payload and rejects lookalikes", () => {
    assert.equal(FixNotice.safeParse({ issue: "hqscope/polya#41", issue_url: ISSUE_URL, status: "done" }).success, true);
    assert.equal(FixNotice.safeParse({ issue: "polya", issue_url: ISSUE_URL, status: "done" }).success, false);
    assert.equal(FixNotice.safeParse({ issue: "hqscope/polya#41", issue_url: "https://evil.example/", status: "done" }).success, false);
    assert.equal(FixNotice.safeParse({ issue: "hqscope/polya#41", issue_url: ISSUE_URL, status: "running" }).success, false);
    assert.equal(
      FixNotice.safeParse({ issue: "hqscope/polya#41", issue_url: ISSUE_URL, status: "pr-ready", pr: { ...openPr, head_sha: "abc" } }).success,
      false,
    );
  });
});

describe("planNotice", () => {
  it("records a ready PR and its head commit, then hands it to Noel", () => {
    const plan = planNotice(fix(), notice({ pr: openPr, summary: "Digest skips threads Noel replied to." }));
    assert.equal(plan.kind, "apply");
    if (plan.kind !== "apply") return;
    assert.deepEqual(plan.update, { status: "pr_ready", prUrl: PR_URL, prNumber: 52, headSha: SHA });
    assert.match(plan.handOff ?? "", /^\[polya fix\]\n/);
    assert.match(plan.handOff ?? "", /fix: 3\nstatus: pr-ready/);
    assert.match(plan.handOff ?? "", new RegExp(`pr: ${PR_URL}`));
    assert.match(plan.handOff ?? "", /summary: Digest skips threads Noel replied to\./);
    assert.match(plan.handOff ?? "", /not instructions/);
  });

  it("is quiet for the same commit, and re-texts when the PR gets new commits", () => {
    const ready = fix({ status: "pr_ready", prUrl: PR_URL, prNumber: 52, headSha: SHA });
    assert.equal(planNotice(ready, notice({ pr: openPr })).kind, "ignore");
    const moved = planNotice(ready, notice({ pr: { ...openPr, head_sha: SHA2 } }));
    assert.equal(moved.kind, "apply");
    if (moved.kind === "apply") assert.equal(moved.update.headSha, SHA2);
  });

  it("ignores a ready notice without an open PR", () => {
    assert.equal(planNotice(fix(), notice()).kind, "ignore");
    assert.equal(planNotice(fix(), notice({ pr: { ...openPr, merged: true } })).kind, "ignore");
  });

  it("passes on stuck fixes once", () => {
    const stuck = planNotice(fix(), notice({ status: "needs-noel", note: "Needs a migration." }));
    assert.equal(stuck.kind, "apply");
    if (stuck.kind === "apply") {
      assert.equal(stuck.update.status, "needs_noel");
      assert.match(stuck.handOff ?? "", /note: Needs a migration\./);
      assert.match(stuck.handOff ?? "", new RegExp(`issue: ${ISSUE_URL}`));
    }
    assert.equal(planNotice(fix({ status: "needs_noel" }), notice({ status: "needs-noel" })).kind, "ignore");
    const failed = planNotice(fix(), notice({ status: "failed", note: "x".repeat(2000) }));
    assert.equal(failed.kind, "apply");
    if (failed.kind === "apply") assert.ok((failed.handOff ?? "").length < 1200);
  });

  it("retires the lesson when the PR merges or closes", () => {
    const merged = planNotice(fix({ status: "pr_ready" }), notice({ status: "done", pr: { ...openPr, merged: true } }));
    assert.equal(merged.kind === "apply" && merged.update.status, "shipped");
    const closed = planNotice(fix({ status: "pr_ready" }), notice({ status: "done", pr: openPr }));
    assert.equal(closed.kind === "apply" && closed.update.status, "closed");
  });

  it("stays quiet after the fix shipped or closed", () => {
    assert.equal(planNotice(fix({ status: "shipped" }), notice({ status: "done", pr: { ...openPr, merged: true } })).kind, "ignore");
    assert.equal(planNotice(fix({ status: "closed" }), notice({ pr: openPr })).kind, "ignore");
  });
});

describe("planShip", () => {
  const ready = fix({ status: "pr_ready", prUrl: PR_URL, prNumber: 52, headSha: SHA });

  it("ships the commit scope-ops reported for the PR Noel was shown", () => {
    assert.deepEqual(planShip(ready, ` ${PR_URL} `), { kind: "ship", issueRef: "hqscope/polya#41", headSha: SHA });
  });

  it("refuses anything else", () => {
    assert.equal(planShip(null, PR_URL).kind, "refuse");
    assert.equal(planShip(fix(), PR_URL).kind, "refuse");
    assert.equal(planShip({ ...ready, status: "shipped" }, PR_URL).kind, "refuse");
    assert.equal(planShip({ ...ready, status: "closed" }, PR_URL).kind, "refuse");
    assert.equal(planShip({ ...ready, headSha: null }, PR_URL).kind, "refuse");
    assert.equal(planShip(ready, "https://github.com/hqscope/polya/pull/53").kind, "refuse");
  });
});
