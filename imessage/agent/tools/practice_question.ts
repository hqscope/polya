import { defineTool } from "eve/tools";
import { z } from "zod";

import { safeTimeZone } from "../lib/dates.ts";
import { serviceDb } from "../lib/db.ts";
import {
  examIdInput,
  findStudentExam,
  loadExamAttempts,
  loadExamQuestions,
  loadExamTopics,
  loadPracticeQuestion,
  loadReservedQuestionIds,
  loadUpcomingExams,
  studyPage,
  type UpcomingExam,
} from "../lib/exams-db.ts";
import { findLinkByUser } from "../lib/link.ts";
import { questionView, type PracticeQuestion, type PublicPart } from "../lib/practice.ts";
import { callStudy, StudyApiError } from "../lib/study-api.ts";
import { pickNext } from "../lib/study-progress.ts";
import { requireStudentId } from "../lib/student.ts";

const questionIdInput = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

interface WrittenQuestion {
  id: string;
  topic_id: string;
  stem: string;
  parts: PublicPart[];
}

export default defineTool({
  description:
    "Gives the student the next practice question for one of their exams from Study on the Polya website: an unanswered question from their weakest topic, a missed one that's due again, or a newly written one (which can take up to a minute or two). Questions are checked before they're shown, and the answer stays hidden until the student answers with answer_practice. Use it when the student wants to be quizzed or to practice for an exam.",
  inputSchema: z.object({
    exam_id: examIdInput.optional().describe("From exam_prep or a [polya exam] text. Leave it out when the student has one upcoming exam."),
    topic: z.string().max(120).optional().describe("Topic words to practice, as the student said them. Leave it out to let Polya pick the weakest topic."),
    skip_question_ids: z
      .array(questionIdInput)
      .max(20)
      .optional()
      .describe("question_ids already shown in this conversation that the student skipped or wants to move past."),
  }),
  label: { start: () => "Finding a practice question" },
  async execute({ exam_id, topic, skip_question_ids }, ctx) {
    const userId = requireStudentId(ctx.session.auth);
    const now = new Date();

    let exam: UpcomingExam | null;
    if (exam_id) {
      exam = await findStudentExam(userId, exam_id);
      if (!exam) return { question: null, reason: "That exam isn't in the student's Polya account. Call exam_prep to list their exams." };
    } else {
      const link = await findLinkByUser(serviceDb(), userId);
      const upcoming = await loadUpcomingExams(userId, now, safeTimeZone(link?.timezone));
      if (upcoming.length === 0) {
        return {
          question: null,
          reason: "The student has no upcoming exams in Study. They can add one on askpolya.com (open a course, then Study).",
        };
      }
      if (upcoming.length > 1) {
        return {
          question: null,
          reason: "The student has several upcoming exams. Ask which one, then call again with its exam_id.",
          exams: upcoming.slice(0, 5).map((e) => ({ exam_id: e.examId, exam: e.title, course: e.courseName, date: e.examDate })),
        };
      }
      exam = upcoming[0]!;
    }

    const topics = await loadExamTopics(userId, exam.examId);
    if (topics.length === 0) {
      return {
        question: null,
        reason: "This exam has no topics yet. The student can have Polya suggest them on the exam's study page.",
        study_page: studyPage(exam),
      };
    }

    let topicId: string | null = null;
    if (topic?.trim()) {
      const words = topic.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const matches = topics.filter((t) => {
        const title = t.title.toLowerCase();
        return title.includes(topic.trim().toLowerCase()) || (words.length > 0 && words.every((w) => title.includes(w)));
      });
      if (matches.length !== 1) {
        return {
          question: null,
          reason: matches.length === 0 ? "No topic on this exam matches. Ask which of these they meant." : "Several topics match. Ask which one.",
          topics: (matches.length === 0 ? topics : matches).map((t) => t.title),
        };
      }
      topicId = matches[0]!.id;
    }

    const [questions, attempts, reserved] = await Promise.all([
      loadExamQuestions(userId, exam.examId),
      loadExamAttempts(userId, exam.examId),
      loadReservedQuestionIds(userId),
    ]);
    // Questions waiting in an unfinished mock exam are never served early.
    const skip = new Set([...reserved, ...(skip_question_ids ?? [])]);
    const step = pickNext({ topics, questions, attempts, now: now.getTime(), topicId, skip });
    if (step.kind === "none") return { question: null, reason: "There's nothing to practice on that topic yet." };

    let question: PracticeQuestion | null = null;
    let servedTopicId: string = step.topicId;
    if (step.kind === "question") {
      question = await loadPracticeQuestion(userId, step.questionId);
    } else {
      try {
        const written = await callStudy<{ questions: WrittenQuestion[] }>(userId, {
          action: "generate_questions",
          exam_id: exam.examId,
          topic_id: step.topicId,
        });
        const first = written.questions[0];
        if (first) {
          question = { id: first.id, stem: first.stem, parts: first.parts, hideTopic: false };
          servedTopicId = first.topic_id;
        }
      } catch (error) {
        if (!(error instanceof StudyApiError)) throw error;
        return { question: null, reason: writeFailureReason(error) };
      }
    }
    if (!question) {
      return {
        question: null,
        reason: "Polya couldn't write a question it was sure of for this topic. Offer another topic, or try again later.",
      };
    }

    const topicTitle = topics.find((t) => t.id === servedTopicId)?.title ?? null;
    return { exam_id: exam.examId, exam: exam.title, ...questionView(question, topicTitle) };
  },
});

function writeFailureReason(error: StudyApiError): string {
  if (error.code === "rate_limited") return error.message;
  if (error.code === "busy") return "Polya is busier than usual right now. Suggest trying again in a little while.";
  if (error.code === "slow" || error.code === "unavailable") {
    return "Writing a new question took longer than usual. Suggest trying again in a minute; nothing was lost.";
  }
  if (error.code === "declined") return "Polya couldn't write questions on this topic. Offer another topic.";
  return "Polya couldn't get a new question just now. Suggest trying again in a moment.";
}
