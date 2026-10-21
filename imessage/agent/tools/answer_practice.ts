import { defineTool } from "eve/tools";
import { z } from "zod";

import { loadPracticeQuestion } from "../lib/exams-db.ts";
import { gradedView, parseAnswers, partLabel, type GradedReply } from "../lib/practice.ts";
import { callStudy, StudyApiError } from "../lib/study-api.ts";
import { requireStudentId } from "../lib/student.ts";

export default defineTool({
  description:
    "Checks the student's answer to a practice question from practice_question and records it, so their progress in Study on the Polya website updates. Returns, per part, whether it was right and the correct answer, plus the worked solution and the course sources it comes from. Call it only after the student has answered every part themselves.",
  inputSchema: z.object({
    question_id: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      .describe("The question_id from practice_question."),
    answers: z
      .array(z.string().max(3000))
      .min(1)
      .max(4)
      .describe(
        "The student's answer to each part, in order (part a first), as they gave it. For one choice, its number; for several, like \"1, 3\"; for a number, what they typed.",
      ),
  }),
  label: { start: () => "Checking your answer" },
  async execute({ question_id, answers }, ctx) {
    const userId = requireStudentId(ctx.session.auth);
    const question = await loadPracticeQuestion(userId, question_id);
    if (!question) return { graded: false, reason: "That question isn't available anymore. Offer a new one." };

    const parsed = parseAnswers(question.parts, answers);
    if (!parsed.ok) return { graded: false, part: parsed.part, reason: parsed.reason };

    try {
      const reply = await callStudy<GradedReply>(userId, {
        action: "submit_attempt",
        question_id,
        responses: parsed.responses,
      });
      return gradedView(question, parsed.responses, reply);
    } catch (error) {
      if (!(error instanceof StudyApiError)) throw error;
      if (error.code === "bad_answer") {
        return { graded: false, part: partLabel(error.part ?? 0), reason: error.message };
      }
      if (error.code === "conflict" || error.code === "rate_limited" || error.code === "not_found") {
        return { graded: false, reason: error.message };
      }
      return {
        graded: false,
        reason: "Polya couldn't check that answer just now. Nothing was recorded; suggest sending it again in a moment.",
      };
    }
  },
});
