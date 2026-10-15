import { defineTool } from "eve/tools";
import { z } from "zod";

import { courseIdInput, getCourseMode, getStudentCourse } from "../lib/courses.ts";
import { serviceDb } from "../lib/db.ts";
import { requireStudentId } from "../lib/student.ts";
import { studyRulesFor } from "../lib/study-rules.ts";

// study-rules.ts is shared with the web connector, where answers render [n] markers. On iMessage
// a bare number points nowhere, so the result says how to cite here.
const CITATION_STYLE =
  "On iMessage, cite in plain words instead of [n]: name the source and where in it, for example (Lecture 7 slides, p. 2).";

export default defineTool({
  description:
    "Returns the study mode the student chose for one of their courses (Open, Guided, Practice or Review): what help is allowed, what isn't, and how help should look in that mode (how_to_help). The student can change the mode at any time.",
  inputSchema: z.object({ course: courseIdInput }),
  label: { start: () => "Checking this course's study rules" },
  async execute({ course }, ctx) {
    const userId = requireStudentId(ctx.session.auth);
    const db = serviceDb();
    const row = await getStudentCourse(db, userId, course);
    const rules = studyRulesFor(await getCourseMode(db, userId, row.id));
    return {
      course_name: row.name,
      mode: rules.mode,
      label: rules.label,
      summary: rules.summary,
      allowed: rules.allowed,
      not_allowed: rules.not_allowed,
      how_to_help: rules.how_to_help,
      citation_style: CITATION_STYLE,
    };
  },
});
