import { defineTool } from "eve/tools";
import { z } from "zod";

import { serviceDb } from "../lib/db.ts";
import { hostOf } from "../lib/inbound.ts";
import { appUrl } from "../lib/link.ts";
import { requireStudentId } from "../lib/student.ts";

interface CourseRow {
  id: string;
  name: string;
  code: string | null;
  term_name: string | null;
  import_status: string;
}

export default defineTool({
  description:
    "Lists the courses the student has added to Polya: each course's id (pass it as `course` to the other course tools), name, code, term, and whether its materials are ready.",
  inputSchema: z.object({}),
  label: { start: () => "Checking your courses" },
  async execute(_input, ctx) {
    const userId = requireStudentId(ctx.session.auth);
    const { data, error } = await serviceDb()
      .from("polya_courses")
      .select("id, name, code, term_name, import_status")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error("Couldn't load the student's courses. Try again in a moment.");

    const courses = ((data ?? []) as CourseRow[]).map((row) => ({
      course: row.id,
      name: row.name,
      code: row.code,
      term: row.term_name,
      ready: row.import_status === "complete",
    }));
    if (courses.length > 0) return { courses };
    return { courses, note: `No courses yet. The student can add one at ${hostOf(appUrl())}.` };
  },
});
