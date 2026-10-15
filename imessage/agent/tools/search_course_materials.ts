// Searches the linked student's own course materials, as Polya's connector does
// (polya/src/lib/mcp/server.ts search_course_materials). The student comes from the session's
// auth, never from the model; the course is matched only against that student's courses.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { serviceDb } from "../lib/db.ts";
import { searchResultText } from "../lib/search-format.ts";
import { searchCourseMaterials } from "../lib/search.ts";
import { requireStudentId } from "../lib/student.ts";

export default defineTool({
  description:
    "Searches one of the student's courses in Polya (readings, slides, pages, lecture transcripts) and returns up to 6 numbered passages, each with its title, where it came from, and a link when one exists. The course's study mode is applied: in Practice mode, answer keys are never returned. Search before explaining anything from a course, and ground the explanation in the passages.",
  inputSchema: z.object({
    course: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'The course id from list_courses, or the course as the student named it ("bio 1a", "Linear Algebra").',
      ),
    query: z.string().min(1).max(2000).describe("What to look for, in a few words or a question."),
  }),
  label: { start: () => "Searching your course materials" },
  async execute({ course, query }, ctx) {
    const studentId = requireStudentId(ctx.session.auth);
    return searchCourseMaterials(serviceDb(), studentId, course, query, ctx.abortSignal);
  },
  toModelOutput(output) {
    return { type: "text", value: searchResultText(output) };
  },
});
