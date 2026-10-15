import { defineTool } from "eve/tools";
import { z } from "zod";

import { courseIdInput } from "../lib/courses.ts";
import { describeDue, safeTimeZone } from "../lib/dates.ts";
import { serviceDb } from "../lib/db.ts";
import { findLinkByUser } from "../lib/link.ts";
import { requireStudentId } from "../lib/student.ts";

const MAX_RESULTS = 20;

interface AssignmentRow {
  title: string;
  due_at: string;
  course_id: string;
}

export default defineTool({
  description:
    "Lists the student's assignments due in the next few days (from their course sites), soonest first, with due times already in the student's own timezone. Optionally limited to one course.",
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

    let query = db
      .from("polya_sources")
      .select("title, due_at, course_id")
      .eq("user_id", userId)
      .eq("origin", "canvas_assignment")
      .gt("due_at", now.toISOString())
      .lte("due_at", until.toISOString())
      .order("due_at", { ascending: true })
      .limit(MAX_RESULTS + 1);
    if (course) query = query.eq("course_id", course);
    const { data, error } = await query;
    if (error) throw new Error("Couldn't load upcoming assignments. Try again in a moment.");
    const rows = (data ?? []) as AssignmentRow[];

    const courseIds = [...new Set(rows.map((row) => row.course_id))];
    const courseNames = new Map<string, string>();
    if (courseIds.length > 0) {
      const courses = await db
        .from("polya_courses")
        .select("id, name")
        .eq("user_id", userId)
        .in("id", courseIds);
      if (courses.error) throw new Error("Couldn't load course names. Try again in a moment.");
      for (const row of (courses.data ?? []) as Array<{ id: string; name: string }>) {
        courseNames.set(row.id, row.name);
      }
    }

    const timeZone = safeTimeZone((await findLinkByUser(db, userId))?.timezone);
    return {
      timezone: timeZone,
      days,
      assignments: rows.slice(0, MAX_RESULTS).map((row) => ({
        title: row.title,
        course: courseNames.get(row.course_id) ?? "Unknown course",
        due: describeDue(new Date(row.due_at), now, timeZone),
      })),
      more_not_shown: rows.length > MAX_RESULTS,
    };
  },
});
