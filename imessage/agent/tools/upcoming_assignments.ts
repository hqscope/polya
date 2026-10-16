import { defineTool } from "eve/tools";
import { z } from "zod";

import { courseIdInput } from "../lib/courses.ts";
import { safeTimeZone } from "../lib/dates.ts";
import { serviceDb } from "../lib/db.ts";
import { findLinkByUser } from "../lib/link.ts";
import { assignmentView, type AssignmentMark } from "../lib/reminders.ts";
import { loadMarks, loadStudentAssignments, type GradescopeState } from "../lib/reminders-db.ts";
import { requireStudentId } from "../lib/student.ts";

const MAX_RESULTS = 20;

const GRADESCOPE_NOTE: Record<GradescopeState, string> = {
  connected: "Submission status comes from Gradescope where the assignment is on Gradescope.",
  not_connected: "Gradescope isn't connected, so submission status is unknown.",
  needs_reconnect: "The student's Gradescope connection expired, so submission status is unknown.",
  error: "Gradescope couldn't be checked right now, so submission status is unknown.",
};

export default defineTool({
  description:
    "Lists the student's assignments due in the next few days (from their course sites and Gradescope), soonest first, with due times already in the student's own timezone and each one's submission status. Optionally limited to one course.",
  inputSchema: z.object({
    days: z.number().int().min(1).max(30).default(7).describe("How many days ahead to look. Default 7."),
    course: courseIdInput.optional(),
  }),
  label: { start: () => "Checking what's due" },
  async execute({ days, course }, ctx) {
    const userId = requireStudentId(ctx.session.auth);
    const db = serviceDb();
    const now = new Date();
    const until = new Date(now.getTime() + days * 86_400_000);

    let loaded: Awaited<ReturnType<typeof loadStudentAssignments>>;
    try {
      loaded = await loadStudentAssignments(userId, now, until, course ? { courseId: course } : {});
    } catch {
      throw new Error("Couldn't load upcoming assignments. Try again in a moment.");
    }
    const shown = loaded.items.slice(0, MAX_RESULTS);
    // Marks only add "student said it's done"; without them the list still works.
    const marks: AssignmentMark[] =
      (await loadMarks(
        userId,
        shown.flatMap((item) => item.keys),
      ).catch(() => null)) ?? [];

    const timeZone = safeTimeZone((await findLinkByUser(db, userId))?.timezone);
    return {
      timezone: timeZone,
      days,
      gradescope: GRADESCOPE_NOTE[loaded.gradescope],
      assignments: shown.map((item) => assignmentView(item, marks, now, timeZone)),
      more_not_shown: loaded.items.length > MAX_RESULTS,
    };
  },
});
