import { defineTool } from "eve/tools";
import { z } from "zod";

import { safeTimeZone } from "../lib/dates.ts";
import { serviceDb } from "../lib/db.ts";
import { examFactsView } from "../lib/exams.ts";
import {
  examIdInput,
  findStudentExam,
  loadExamFacts,
  loadUpcomingExams,
  studyPage,
  type UpcomingExam,
} from "../lib/exams-db.ts";
import { findLinkByUser } from "../lib/link.ts";
import { requireStudentId } from "../lib/student.ts";

const MAX_EXAMS = 3;

export default defineTool({
  description:
    "The student's upcoming exams from Study on the Polya website: for each, the topics weakest first with how each is going, key formulas, open mistakes from their log, today's study plan, mock exam results, and a link to the exam's study page. Use it when the student asks what to review, how ready they are, or what to remember for an exam, before quizzing them, and for follow-ups to a [polya exam] text. Pass exam_id for one exam; leave it out for the next few upcoming exams.",
  inputSchema: z.object({ exam_id: examIdInput.optional() }),
  label: { start: () => "Looking at your exam prep" },
  async execute({ exam_id }, ctx) {
    const userId = requireStudentId(ctx.session.auth);
    const now = new Date();
    const link = await findLinkByUser(serviceDb(), userId);
    const timezone = safeTimeZone(link?.timezone);

    const exams: UpcomingExam[] = exam_id
      ? [await findStudentExam(userId, exam_id)].filter((exam): exam is UpcomingExam => exam !== null)
      : (await loadUpcomingExams(userId, now, timezone)).slice(0, MAX_EXAMS);
    if (exams.length === 0) {
      return {
        exams: [],
        note: exam_id
          ? "That exam isn't in the student's Polya account. Call exam_prep without an exam_id to list their exams."
          : "No upcoming exams with a date. The student can add one in Study on askpolya.com (open a course, then Study), and Polya will help them prepare.",
      };
    }

    const views = [];
    for (const exam of exams) {
      const facts = await loadExamFacts(userId, exam.examId, now, timezone);
      if (facts) views.push({ ...examFactsView(facts, now, timezone), study_page: studyPage(exam) });
    }
    return { exams: views };
  },
});
