import { defineTool } from "eve/tools";
import { z } from "zod";

import { courseIdInput, getCourseMode, getStudentCourse } from "../lib/courses.ts";
import { serviceDb } from "../lib/db.ts";
import { requireStudentId } from "../lib/student.ts";
import { studyRulesFor } from "../lib/study-rules.ts";

// Same write as the web app's study-mode picker (src/components/policy/PolicyPanel.tsx): the student
// owns the mode of their own course. The course is checked to be theirs before anything is written.
export default defineTool({
  description:
    "Changes the study mode of one of the student's courses to Open, Guided, Practice or Review, when the student asks for it. Returns the new rules, which apply from the next request on.",
  inputSchema: z.object({
    course: courseIdInput,
    mode: z.enum(["open", "guided", "practice", "review"]).describe("The mode the student asked for."),
  }),
  label: { start: () => "Changing this course's study mode" },
  async execute({ course, mode }, ctx) {
    const userId = requireStudentId(ctx.session.auth);
    const db = serviceDb();
    const row = await getStudentCourse(db, userId, course);
    const before = await getCourseMode(db, userId, row.id);
    const { error } = await db
      .from("polya_course_policies")
      .upsert({ course_id: row.id, user_id: userId, mode, updated_at: new Date().toISOString() }, { onConflict: "course_id" });
    if (error) return { changed: false, message: "Couldn't change the mode right now. Try again in a minute." };
    const rules = studyRulesFor(mode);
    return {
      changed: before !== mode,
      course_name: row.name,
      previous_mode: before,
      mode: rules.mode,
      label: rules.label,
      summary: rules.summary,
      allowed: rules.allowed,
      not_allowed: rules.not_allowed,
    };
  },
});
