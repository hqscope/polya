import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectCheckIns, type CheckInLink, type SentCheckIn } from "../agent/lib/check-ins.ts";
import type { GsAssignment } from "../agent/lib/gradescope/types.ts";
import {
  coursesMatch,
  isItemKey,
  mergeAssignments,
  pickAssignment,
  prepareCheckIns,
  titleScore,
  titleTokens,
  type AssignmentMark,
  type CanvasAssignmentInput,
  type ReminderItem,
  type ReminderMode,
} from "../agent/lib/reminders.ts";

const STUDENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const HW7 = "aaaaaaaa-0000-4000-8000-000000000007";
const LAB5 = "aaaaaaaa-0000-4000-8000-000000000005";

// Thu Oct 15 2026, 9:00 AM in Los Angeles (PDT, UTC-7) and 12:00 PM in New York (EDT, UTC-4).
const THU_9AM_LA = new Date("2026-10-15T16:00:00Z");
const FRI_1159PM_LA = "2026-10-17T06:59:00Z"; // due_soon from THU_9AM_LA (~38h)
const THU_1159PM_LA = "2026-10-16T06:59:00Z"; // due_today in Los Angeles, tomorrow in New York

function canvas(sourceId: string, title: string, dueAt: string | null, overrides: Partial<CanvasAssignmentInput> = {}): CanvasAssignmentInput {
  return { sourceId, userId: STUDENT, courseName: "Structure and Interpretation", courseCode: "COMPSCI 61A", title, dueAt, ...overrides };
}

function gs(assignmentId: string, title: string, dueAt: string | null, status: GsAssignment["status"], overrides: Partial<GsAssignment> = {}): GsAssignment {
  return {
    course_id: "900",
    course_name: "CS 61A",
    assignment_id: assignmentId,
    title,
    due_at: dueAt,
    late_due_at: null,
    status,
    score: null,
    url: `https://www.gradescope.com/courses/900/assignments/${assignmentId}`,
    ...overrides,
  };
}

function link(overrides: Partial<CheckInLink> = {}): CheckInLink {
  return {
    userId: STUDENT,
    threadId: "imessage:thread",
    timezone: "America/Los_Angeles",
    checkInsEnabled: true,
    quietStart: 22,
    quietEnd: 8,
    ...overrides,
  };
}

/** Items -> prepareCheckIns -> selectCheckIns, as the loop runs them. */
function plan(input: {
  items: ReminderItem[];
  marks?: AssignmentMark[];
  sent?: SentCheckIn[];
  mode?: ReminderMode;
  link?: CheckInLink;
  now?: Date;
}) {
  const now = input.now ?? THU_9AM_LA;
  const prepared = prepareCheckIns({
    userId: STUDENT,
    mode: input.mode ?? "reminders",
    items: input.items,
    marks: input.marks ?? [],
    sent: input.sent ?? [],
    now,
  });
  return selectCheckIns({ links: [input.link ?? link()], assignments: prepared.assignments, sent: prepared.sent, now })[0];
}

function picked(input: Parameters<typeof plan>[0]): [string, string][] {
  return (plan(input)?.items ?? []).map((item) => [item.sourceId, item.kind]);
}

describe("title matching", () => {
  it("normalizes HW 7, Homework 7 and hw07 to the same words", () => {
    assert.deepEqual(titleTokens("HW 7"), ["homework", "7"]);
    assert.deepEqual(titleTokens("Homework 7"), ["homework", "7"]);
    assert.deepEqual(titleTokens("hw07"), ["homework", "7"]);
    assert.deepEqual(titleTokens("PS4"), ["problem", "set", "4"]);
    assert.equal(titleScore("HW 7", "hw07"), 1);
    assert.equal(titleScore("Problem Set 4", "PS 4"), 1);
  });

  it("matches when one title's words contain the other's", () => {
    assert.ok(titleScore("HW 7: Recursion", "Homework 7") > 0);
  });

  it("keeps different numbers, parts and kinds apart", () => {
    assert.equal(titleScore("Homework 7", "Homework 17"), 0);
    assert.equal(titleScore("Homework 7", "Homework 8"), 0);
    assert.equal(titleScore("Project 1a", "Project 1b"), 0);
    assert.equal(titleScore("Lab 7", "Homework 7"), 0);
    assert.equal(titleScore("Homework 7 Written", "Homework 7 Coding"), 0);
  });
});

describe("course matching", () => {
  it("matches the same course number with a compatible subject", () => {
    assert.equal(coursesMatch(["Structure and Interpretation", "COMPSCI 61A"], "CS 61A"), true);
    assert.equal(coursesMatch(["COMPSCI 61A Fall 2026", null], "CS 61A"), true);
    assert.equal(coursesMatch(["Data C100 Sp26", null], "Data 100"), true);
    assert.equal(coursesMatch(["MCB 32", null], "Molecular and Cell Biology 32"), true);
  });

  it("rejects a different number or subject, ignoring years and section numbers", () => {
    assert.equal(coursesMatch(["Fall 2026 COMPSCI 61B LEC 001", null], "CS 61A"), false);
    assert.equal(coursesMatch(["BIO 1A", null], "CHEM 1A"), false);
    assert.equal(coursesMatch(["Chemistry 1A", null], "CS 1A"), false, "letters scattered in a word aren't an abbreviation");
    assert.equal(coursesMatch(["CS 61A 2026", null], "MATH 2026"), false);
  });
});

describe("merging Canvas and Gradescope", () => {
  it("keeps one item for the same assignment and uses Gradescope's status", () => {
    const items = mergeAssignments(STUDENT, [canvas(HW7, "HW 7", FRI_1159PM_LA)], [gs("1007", "Homework 7", FRI_1159PM_LA, "submitted")]);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.itemKey, `canvas:${HW7}`);
    assert.deepEqual(items[0]?.keys, [`canvas:${HW7}`, "gs:900:1007"]);
    assert.equal(items[0]?.gradescopeStatus, "submitted");
  });

  it("keeps unmatched assignments from both sides", () => {
    const items = mergeAssignments(
      STUDENT,
      [canvas(LAB5, "Lab 5", FRI_1159PM_LA)],
      [gs("1007", "Homework 7", FRI_1159PM_LA, "not_submitted")],
    );
    assert.deepEqual(
      items.map((item) => [item.itemKey, item.gradescopeStatus]),
      [
        [`canvas:${LAB5}`, null],
        ["gs:900:1007", "not_submitted"],
      ],
    );
  });

  it("needs every Gradescope part submitted before the Canvas assignment counts as submitted", () => {
    const parts = [gs("71", "Homework 7 Written", FRI_1159PM_LA, "submitted"), gs("72", "Homework 7 Coding", FRI_1159PM_LA, "not_submitted")];
    const [item] = mergeAssignments(STUDENT, [canvas(HW7, "Homework 7", FRI_1159PM_LA)], parts);
    assert.equal(item?.gradescopeStatus, "not_submitted");
    assert.deepEqual(item?.keys, [`canvas:${HW7}`, "gs:900:71", "gs:900:72"]);
  });

  it("doesn't merge across courses or far-apart due dates", () => {
    const otherCourse = gs("1007", "Homework 7", FRI_1159PM_LA, "submitted", { course_name: "CS 61B" });
    const nextWeek = gs("1008", "Homework 7", "2026-10-23T06:59:00Z", "submitted");
    const items = mergeAssignments(STUDENT, [canvas(HW7, "Homework 7", FRI_1159PM_LA)], [otherCourse, nextWeek]);
    assert.equal(items.length, 3);
    assert.equal(items[0]?.gradescopeStatus, null);
  });

  it("ignores another student's Canvas rows", () => {
    const items = mergeAssignments(STUDENT, [canvas(HW7, "Homework 7", FRI_1159PM_LA, { userId: OTHER })], null);
    assert.deepEqual(items, []);
  });
});

describe("submission-aware reminders", () => {
  it("skips an assignment Gradescope says is submitted or graded", () => {
    const submitted = mergeAssignments(STUDENT, [canvas(HW7, "HW 7", FRI_1159PM_LA)], [gs("1007", "Homework 7", FRI_1159PM_LA, "submitted")]);
    assert.deepEqual(picked({ items: submitted }), []);
    const graded = mergeAssignments(STUDENT, [], [gs("1007", "Homework 7", FRI_1159PM_LA, "graded")]);
    assert.deepEqual(picked({ items: graded }), []);
  });

  it("reminds about a not-submitted assignment with its status and item key", () => {
    const items = mergeAssignments(STUDENT, [canvas(HW7, "HW 7", FRI_1159PM_LA)], [gs("1007", "Homework 7", FRI_1159PM_LA, "not_submitted")]);
    const result = plan({ items });
    assert.deepEqual(
      result?.items.map((item) => [item.sourceId, item.kind]),
      [[`canvas:${HW7}`, "due_soon"]],
    );
    assert.equal(
      result?.message,
      [
        "[polya check-in]",
        "",
        "assignment: HW 7",
        "course: Structure and Interpretation",
        "due: tomorrow at 11:59 PM PDT (Fri, Oct 16)",
        "status: not submitted on Gradescope",
        `item_key: canvas:${HW7}`,
      ].join("\n"),
    );
  });

  it("says the status is unknown without Gradescope, and reminds Gradescope-only assignments", () => {
    const items = mergeAssignments(
      STUDENT,
      [canvas(LAB5, "Lab 5", THU_1159PM_LA)],
      [gs("1007", "Homework 7", FRI_1159PM_LA, "unknown")],
    );
    const result = plan({ items });
    assert.deepEqual(
      result?.items.map((item) => [item.sourceId, item.kind, item.status]),
      [
        [`canvas:${LAB5}`, "due_today", "submission status unknown"],
        ["gs:900:1007", "due_soon", "Gradescope status unknown"],
      ],
    );
  });

  it("skips done items and active snoozes, under any of the item's keys", () => {
    const items = mergeAssignments(STUDENT, [canvas(HW7, "HW 7", FRI_1159PM_LA)], [gs("1007", "Homework 7", FRI_1159PM_LA, "not_submitted")]);
    assert.deepEqual(picked({ items, marks: [{ itemKey: "gs:900:1007", status: "done", until: null }] }), []);
    assert.deepEqual(picked({ items, marks: [{ itemKey: `canvas:${HW7}`, status: "snoozed", until: "2026-10-16T16:00:00Z" }] }), []);
    assert.deepEqual(
      picked({ items, marks: [{ itemKey: `canvas:${HW7}`, status: "snoozed", until: "2026-10-15T15:00:00Z" }] }),
      [[`canvas:${HW7}`, "due_soon"]],
      "a snooze that ended doesn't hold",
    );
  });

  it("dedupes a send recorded under a merged item's Gradescope key", () => {
    const items = mergeAssignments(STUDENT, [canvas(HW7, "HW 7", FRI_1159PM_LA)], [gs("1007", "Homework 7", FRI_1159PM_LA, "not_submitted")]);
    const sent: SentCheckIn[] = [{ userId: STUDENT, sourceId: "gs:900:1007", kind: "due_soon", sentAt: "2026-10-15T15:30:00Z" }];
    assert.deepEqual(picked({ items, sent }), []);
  });

  it("falls back to Canvas source ids and drops Gradescope-only items in legacy mode", () => {
    const items = mergeAssignments(
      STUDENT,
      [canvas(HW7, "HW 7", FRI_1159PM_LA), canvas(LAB5, "Lab 5", THU_1159PM_LA)],
      [gs("1007", "Homework 7", FRI_1159PM_LA, "submitted"), gs("1010", "Homework 10", FRI_1159PM_LA, "not_submitted")],
    );
    const result = plan({ items, mode: "legacy" });
    assert.deepEqual(
      result?.items.map((item) => [item.sourceId, item.kind, item.itemKey]),
      [[LAB5, "due_today", `canvas:${LAB5}`]],
    );
    // Legacy sends are keyed by source id.
    const sent: SentCheckIn[] = [{ userId: STUDENT, sourceId: LAB5, kind: "due_today", sentAt: "2026-10-15T15:30:00Z" }];
    assert.deepEqual(picked({ items, mode: "legacy", sent }), []);
  });

  it("decides due_today in the student's own time zone", () => {
    const items = mergeAssignments(STUDENT, [], [gs("1007", "Homework 7", THU_1159PM_LA, "not_submitted")]);
    // 11:59 PM PDT Thu is 2:59 AM Fri in New York: under 24h away and not today there.
    assert.deepEqual(picked({ items }), [["gs:900:1007", "due_today"]]);
    assert.deepEqual(picked({ items, link: link({ timezone: "America/New_York" }) }), []);
  });

  it("keeps quiet hours and the per-run cap", () => {
    const items = mergeAssignments(
      STUDENT,
      [],
      ["1", "2", "3"].map((id) => gs(id, `Homework ${id}`, FRI_1159PM_LA, "not_submitted")),
    );
    assert.equal(plan({ items })?.items.length, 2);
    // Thu 10:30 PM PDT.
    assert.equal(plan({ items, now: new Date("2026-10-16T05:30:00Z") }), undefined);
  });
});

describe("finding the assignment a student means", () => {
  const items = mergeAssignments(
    STUDENT,
    [canvas(HW7, "Homework 7", FRI_1159PM_LA), canvas(LAB5, "Lab 5", FRI_1159PM_LA)],
    [gs("1007", "HW 7", FRI_1159PM_LA, "not_submitted"), gs("77", "Homework 7 Coding", "2026-10-22T06:59:00Z", "not_submitted")],
  );

  it("finds by any of the item's keys", () => {
    const pick = pickAssignment(items, { itemKey: "gs:900:1007" });
    assert.equal(pick.kind === "found" && pick.item.itemKey, `canvas:${HW7}`);
  });

  it("finds by title words, preferring an exact title", () => {
    const pick = pickAssignment(items, { title: "hw 7" });
    assert.equal(pick.kind === "found" && pick.item.itemKey, `canvas:${HW7}`);
    const coding = pickAssignment(items, { title: "hw7 coding" });
    assert.equal(coding.kind === "found" && coding.item.itemKey, "gs:900:77");
  });

  it("reports ambiguity and misses", () => {
    assert.equal(pickAssignment(items, { title: "7" }).kind, "ambiguous");
    assert.equal(pickAssignment(items, { title: "hw 8" }).kind, "none");
    assert.equal(pickAssignment(items, { itemKey: "gs:900:missing" }).kind, "none");
  });

  it("validates item keys", () => {
    assert.equal(isItemKey(`canvas:${HW7}`), true);
    assert.equal(isItemKey("gs:900:1007"), true);
    assert.equal(isItemKey("canvas:not-a-uuid"), false);
    assert.equal(isItemKey(HW7), false);
  });
});
