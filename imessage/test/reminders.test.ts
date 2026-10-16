import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectCheckIns, type CheckInLink, type SentCheckIn } from "../agent/lib/check-ins.ts";
import type { GsAssignment } from "../agent/lib/gradescope/types.ts";
import {
  BASELINE_SENT_AT,
  coursesMatch,
  gradescopeBaseline,
  isItemKey,
  isNewlyPosted,
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
  gradescope?: GsAssignment[] | null;
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
    gradescope: input.gradescope ?? null,
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
        "type: due soon",
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

describe("graded check-ins", () => {
  const graded = gs("1006", "Homework 6", "2026-10-10T06:59:00Z", "graded", { score: "8.0 / 10.0" });

  it("texts a Gradescope score once, under the assignment's own Gradescope key", () => {
    const items = mergeAssignments(STUDENT, [], [graded]);
    const result = plan({ items, gradescope: [graded] });
    assert.deepEqual(
      result?.items.map((item) => [item.sourceId, item.kind]),
      [["gs:900:1006", "graded"]],
    );
    assert.match(
      result?.message ?? "",
      /\n\ntype: graded\nassignment: Homework 6\ncourse: CS 61A\nscore: 8\.0 \/ 10\.0\nitem_key: gs:900:1006$/,
    );
    const sent: SentCheckIn[] = [{ userId: STUDENT, sourceId: "gs:900:1006", kind: "graded", sentAt: "2026-10-14T18:00:00Z" }];
    assert.deepEqual(picked({ items, gradescope: [graded], sent }), []);
  });

  it("needs a score shown, and stays off without Gradescope events or in legacy mode", () => {
    const noScore = { ...graded, score: null };
    assert.deepEqual(picked({ items: mergeAssignments(STUDENT, [], [noScore]), gradescope: [noScore] }), []);
    const items = mergeAssignments(STUDENT, [], [graded]);
    assert.deepEqual(picked({ items, gradescope: null }), []);
    assert.deepEqual(picked({ items, gradescope: [graded], mode: "legacy" }), []);
  });

  it("texts each graded part of a merged assignment once, under its own key", () => {
    const parts = [
      gs("71", "Homework 7 Written", "2026-10-13T06:59:00Z", "graded", { score: "9 / 10" }),
      gs("72", "Homework 7 Coding", "2026-10-13T06:59:00Z", "graded", { score: "4 / 5" }),
    ];
    const items = mergeAssignments(STUDENT, [canvas(HW7, "Homework 7", "2026-10-13T06:59:00Z")], parts);
    assert.deepEqual(picked({ items, gradescope: parts }), [
      ["gs:900:71", "graded"],
      ["gs:900:72", "graded"],
    ]);
    // A graded row stays under its Gradescope key instead of folding onto the Canvas item.
    const sent: SentCheckIn[] = [{ userId: STUDENT, sourceId: "gs:900:71", kind: "graded", sentAt: "2026-10-14T18:00:00Z" }];
    assert.deepEqual(picked({ items, gradescope: parts, sent }), [["gs:900:72", "graded"]]);
  });

  it("still texts a grade after the student said the assignment is done", () => {
    const items = mergeAssignments(STUDENT, [], [graded]);
    const marks: AssignmentMark[] = [{ itemKey: "gs:900:1006", status: "done", until: null }];
    assert.deepEqual(picked({ items, gradescope: [graded], marks }), [["gs:900:1006", "graded"]]);
  });

  it("keeps quiet hours", () => {
    const items = mergeAssignments(STUDENT, [], [graded]);
    assert.equal(plan({ items, gradescope: [graded], now: new Date("2026-10-16T05:30:00Z") }), undefined, "Thu 10:30 PM PDT");
  });
});

describe("new-assignment check-ins", () => {
  const HW8 = "aaaaaaaa-0000-4000-8000-000000000008";
  const MON_1159PM_LA = "2026-10-20T06:59:00Z"; // more than 48h after THU_9AM_LA
  const COURSE_ADDED = "2026-09-01T00:00:00Z";
  const freshCanvas = (overrides: Partial<CanvasAssignmentInput> = {}) =>
    canvas(HW8, "Homework 8", MON_1159PM_LA, { createdAt: "2026-10-15T14:00:00Z", courseCreatedAt: COURSE_ADDED, ...overrides });

  it("announces a Canvas assignment Polya picked up in the last day, with no submission status", () => {
    const result = plan({ items: mergeAssignments(STUDENT, [freshCanvas()], null) });
    assert.deepEqual(
      result?.items.map((item) => [item.sourceId, item.kind]),
      [[`canvas:${HW8}`, "new_assignment"]],
    );
    assert.equal(
      result?.message,
      [
        "[polya check-in]",
        "",
        "type: new assignment",
        "assignment: Homework 8",
        "course: Structure and Interpretation",
        "due: Mon, Oct 19 at 11:59 PM PDT",
        `item_key: canvas:${HW8}`,
      ].join("\n"),
    );
  });

  it("doesn't announce what a course import brought in, or anything older than a day", () => {
    assert.deepEqual(picked({ items: mergeAssignments(STUDENT, [freshCanvas({ courseCreatedAt: "2026-10-15T13:55:00Z" })], null) }), []);
    assert.deepEqual(picked({ items: mergeAssignments(STUDENT, [freshCanvas({ createdAt: "2026-10-14T15:00:00Z" })], null) }), []);
    assert.deepEqual(picked({ items: mergeAssignments(STUDENT, [freshCanvas({ createdAt: null })], null) }), []);
  });

  it("measures 'the last day' and 'course added a day before' inclusively", () => {
    const now = new Date("2026-10-15T16:00:00Z");
    const item = { canvasCreatedAt: "2026-10-14T16:00:00Z", courseCreatedAt: "2026-10-13T16:00:00Z" };
    assert.equal(isNewlyPosted(item, now), true);
    assert.equal(isNewlyPosted(item, new Date(now.getTime() + 1)), false, "24h plus 1ms old");
    assert.equal(isNewlyPosted({ ...item, courseCreatedAt: "2026-10-13T16:00:01Z" }, now), false, "course added under 24h before");
  });

  it("gives a new assignment due within 48 hours the usual due reminder instead", () => {
    const soon = freshCanvas({ dueAt: FRI_1159PM_LA });
    assert.deepEqual(picked({ items: mergeAssignments(STUDENT, [soon], null) }), [[`canvas:${HW8}`, "due_soon"]]);
    const gsSoon = gs("1009", "Homework 9", FRI_1159PM_LA, "not_submitted");
    assert.deepEqual(picked({ items: mergeAssignments(STUDENT, [], [gsSoon]), gradescope: [gsSoon] }), [["gs:900:1009", "due_soon"]]);
  });

  it("announces a Gradescope-only assignment with no earlier row, only while Gradescope events are on", () => {
    const fresh = gs("1008", "Homework 8", MON_1159PM_LA, "not_submitted");
    const items = mergeAssignments(STUDENT, [], [fresh]);
    assert.deepEqual(picked({ items, gradescope: [fresh] }), [["gs:900:1008", "new_assignment"]]);
    assert.deepEqual(picked({ items, gradescope: null }), [], "baseline not recorded");
    const anyRow: SentCheckIn[] = [{ userId: STUDENT, sourceId: "gs:900:1008", kind: "due_soon", sentAt: "2026-10-01T18:00:00Z" }];
    assert.deepEqual(picked({ items, gradescope: [fresh], sent: anyRow }), [], "any earlier row means it's been seen");
  });

  it("lets Canvas decide for an assignment both list", () => {
    const twin = gs("1008", "HW 8", MON_1159PM_LA, "not_submitted");
    const oldCanvas = freshCanvas({ createdAt: "2026-10-10T14:00:00Z" });
    assert.deepEqual(picked({ items: mergeAssignments(STUDENT, [oldCanvas], [twin]), gradescope: [twin] }), [], "posted on Canvas days ago");
    // Already announced under its Gradescope key before Canvas had it.
    const announced: SentCheckIn[] = [{ userId: STUDENT, sourceId: "gs:900:1008", kind: "new_assignment", sentAt: "2026-10-15T02:00:00Z" }];
    assert.deepEqual(picked({ items: mergeAssignments(STUDENT, [freshCanvas()], [twin]), gradescope: [twin], sent: announced }), []);
  });
});

describe("first run with Gradescope (no flood)", () => {
  const MON_1159PM_LA = "2026-10-20T06:59:00Z";
  const before = [
    gs("1005", "Homework 5", "2026-10-08T06:59:00Z", "graded", { score: "10 / 10" }),
    gs("1006", "Homework 6", "2026-10-14T06:59:00Z", "submitted"),
    gs("1007", "Homework 7", FRI_1159PM_LA, "not_submitted"),
    gs("1008", "Homework 8", MON_1159PM_LA, "not_submitted"),
    gs("2001", "Project 1", "2026-11-05T06:59:00Z", "not_submitted"),
  ];
  const asSent = (rows: ReturnType<typeof gradescopeBaseline>): SentCheckIn[] =>
    rows.map((row) => ({ userId: STUDENT, sourceId: row.itemKey, kind: row.kind, sentAt: BASELINE_SENT_AT }));

  it("records every assignment it can see, plus the grades already in", () => {
    assert.deepEqual(gradescopeBaseline([...before, before[0] as GsAssignment]), [
      { itemKey: "gs:900:1005", kind: "new_assignment" },
      { itemKey: "gs:900:1005", kind: "graded" },
      { itemKey: "gs:900:1006", kind: "new_assignment" },
      { itemKey: "gs:900:1007", kind: "new_assignment" },
      { itemKey: "gs:900:1008", kind: "new_assignment" },
      { itemKey: "gs:900:2001", kind: "new_assignment" },
    ]);
  });

  it("announces nothing the student already had, while due reminders still go out", () => {
    const items = mergeAssignments(STUDENT, [], before);
    const baseline = asSent(gradescopeBaseline(before));
    assert.deepEqual(picked({ items, gradescope: before, sent: baseline }), [["gs:900:1007", "due_soon"]]);
    // Without the baseline the same run would have announced old work.
    assert.deepEqual(picked({ items, gradescope: before }), [
      ["gs:900:1007", "due_soon"],
      ["gs:900:1008", "new_assignment"],
    ]);
  });

  it("doesn't count baseline rows toward the daily cap", () => {
    const items = mergeAssignments(STUDENT, [], before);
    const threeToday: SentCheckIn[] = ["a", "b", "c"].map((id) => ({
      userId: STUDENT,
      sourceId: `gs:1:${id}`,
      kind: "due_today",
      sentAt: "2026-10-15T15:30:00Z",
    }));
    const sent = [...asSent(gradescopeBaseline(before)), ...threeToday];
    assert.deepEqual(picked({ items, gradescope: before, sent }), [["gs:900:1007", "due_soon"]]);
  });

  it("announces assignments and grades that show up after the baseline", () => {
    const baseline = asSent(gradescopeBaseline(before));
    const later = [
      gs("1006", "Homework 6", "2026-10-14T06:59:00Z", "graded", { score: "7.5 / 10" }),
      ...before.filter((a) => a.assignment_id !== "1006"),
      gs("1010", "Homework 10", "2026-10-27T06:59:00Z", "not_submitted"),
    ];
    const items = mergeAssignments(STUDENT, [], later);
    const sentEarlier: SentCheckIn[] = [
      ...baseline,
      { userId: STUDENT, sourceId: "gs:900:1007", kind: "due_soon", sentAt: "2026-10-15T15:00:00Z" },
    ];
    assert.deepEqual(picked({ items, gradescope: later, sent: sentEarlier }), [
      ["gs:900:1010", "new_assignment"],
      ["gs:900:1006", "graded"],
    ]);
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
