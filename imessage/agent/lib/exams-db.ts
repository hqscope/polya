// Database side of exam reminders and the exam tools. serviceDb() bypasses RLS, so every query
// filters by the linked student's user_id; an exam, topic, or question id from the model only
// resolves when it belongs to that student.
import { z } from "zod";

import { loadReminderSends, parseRows } from "./check-ins-db.ts";
import { serviceDb } from "./db.ts";
import {
  ExamKindUnavailableError,
  localDate,
  orderTopics,
  type ExamCandidate,
  type ExamFacts,
  type ExamReminderKind,
  type SentReminder,
} from "./exams.ts";
import { appUrl } from "./link.ts";
import { isMissingTableError } from "./notes.ts";
import type { PracticeQuestion, PublicPart } from "./practice.ts";
import { errorStatus, stagesByTopic, type ProgressAttempt, type ProgressQuestion } from "./study-progress.ts";

const REMINDERS_TABLE = "polya_imessage_reminders";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const UPCOMING_LIMIT = 20;

export interface UpcomingExam extends ExamCandidate {
  readonly title: string;
  readonly courseId: string;
  readonly courseName: string | null;
}

/** Tool input for an exam id, as exam_prep and [polya exam] texts give it. */
export const examIdInput = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Use an exam_id from exam_prep or an exam text.")
  .describe("The exam_id from exam_prep or from a [polya exam] text.");

/** The exam's page in Study on the Polya website: where mock exams and the full plan live. */
export function studyPage(exam: Pick<UpcomingExam, "courseId" | "examId">): string {
  return new URL(`/app/courses/${exam.courseId}/study/${exam.examId}`, `${appUrl().replace(/\/+$/, "")}/`).toString();
}

const examRow = z.object({
  id: z.string(),
  course_id: z.string(),
  title: z.string(),
  exam_date: z.string(),
});

/** The student's exams dated today or later in their time zone, soonest first. */
export async function loadUpcomingExams(userId: string, now: Date, timezone: string): Promise<UpcomingExam[]> {
  const db = serviceDb();
  const { data, error } = await db
    .from("polya_exams")
    .select("id, course_id, title, exam_date")
    .eq("user_id", userId)
    .not("exam_date", "is", null)
    .gte("exam_date", localDate(now, timezone))
    .order("exam_date", { ascending: true })
    .limit(UPCOMING_LIMIT);
  if (error) throw new Error(`Couldn't load exams: ${error.message}`);
  const exams = parseRows(examRow, data);
  const names = await courseNames(userId, exams.map((exam) => exam.course_id));
  return exams.map((exam) => ({
    examId: exam.id,
    examDate: exam.exam_date,
    title: exam.title,
    courseId: exam.course_id,
    courseName: names.get(exam.course_id) ?? null,
  }));
}

/** One of the student's exams by id (any date), or null when it isn't theirs. */
export async function findStudentExam(userId: string, examId: string): Promise<UpcomingExam | null> {
  const { data, error } = await serviceDb()
    .from("polya_exams")
    .select("id, course_id, title, exam_date")
    .eq("id", examId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Couldn't load that exam: ${error.message}`);
  const row = z.object({ id: z.string(), course_id: z.string(), title: z.string(), exam_date: z.string().nullable() }).safeParse(data);
  if (!row.success) return null;
  const names = await courseNames(userId, [row.data.course_id]);
  return {
    examId: row.data.id,
    examDate: row.data.exam_date ?? "",
    title: row.data.title,
    courseId: row.data.course_id,
    courseName: names.get(row.data.course_id) ?? null,
  };
}

/**
 * Reminder rows for these exam keys plus the student's last 26 hours (the daily cap). Null when
 * polya_imessage_reminders doesn't exist yet.
 */
export async function loadExamSends(userId: string, itemKeys: readonly string[], now: Date): Promise<SentReminder[] | null> {
  const rows = await loadReminderSends(userId, itemKeys, now);
  return rows?.map((row) => ({ itemKey: row.sourceId, kind: row.kind, sentAt: row.sentAt })) ?? null;
}

/**
 * Records an exam text before it's sent. Returns the row id when this run won, or null when an
 * overlapping run already claimed it. Throws ExamKindUnavailableError until the database accepts
 * the exam kinds (or has the table).
 */
export async function claimExamReminder(userId: string, itemKey: string, kind: ExamReminderKind): Promise<number | string | null> {
  const { data, error } = await serviceDb()
    .from(REMINDERS_TABLE)
    .insert({ user_id: userId, item_key: itemKey, kind })
    .select("id")
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return null;
    if (error.code === CHECK_VIOLATION || isMissingTableError(error)) throw new ExamKindUnavailableError();
    throw new Error(`Couldn't record the exam reminder: ${error.message}`);
  }
  const row = z.object({ id: z.union([z.number(), z.string()]) }).safeParse(data);
  if (!row.success) throw new Error("Couldn't record the exam reminder: the insert returned no id");
  return row.data.id;
}

/** Deletes a claim whose message failed to send, so a later run can try again. */
export async function releaseExamReminder(userId: string, id: number | string): Promise<void> {
  const { error } = await serviceDb().from(REMINDERS_TABLE).delete().eq("user_id", userId).eq("id", id);
  if (error) throw new Error(`Couldn't release the exam reminder: ${error.message}`);
}

const topicRow = z.object({
  id: z.string(),
  position: z.number(),
  title: z.string(),
  key_formulas: z.array(z.string()).nullable().optional(),
  stage: z.string().nullable().optional(),
});

const attemptRow = z.object({
  question_id: z.string(),
  topic_id: z.string(),
  topic_ids: z.array(z.string()).nullable().optional(),
  score: z.number(),
  all_correct: z.boolean(),
  created_at: z.string(),
});

const errorRow = z.object({
  id: z.string(),
  topic_id: z.string().nullable(),
  what: z.string(),
  fix: z.string(),
  created_at: z.string(),
});

const planShape = z.object({
  days: z.array(
    z.object({
      date: z.string(),
      items: z.array(z.object({ text: z.string(), done: z.boolean().optional() })),
    }),
  ),
});

export interface ExamTopicRow {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly keyFormulas: readonly string[];
  readonly stage: string | null;
}

export async function loadExamTopics(userId: string, examId: string): Promise<ExamTopicRow[]> {
  const { data, error } = await serviceDb()
    .from("polya_study_topics")
    .select("id, position, title, key_formulas, stage")
    .eq("exam_id", examId)
    .eq("user_id", userId)
    .order("position", { ascending: true });
  if (error) throw new Error(`Couldn't load the exam's topics: ${error.message}`);
  return parseRows(topicRow, data).map((t) => ({
    id: t.id,
    position: t.position,
    title: t.title,
    keyFormulas: t.key_formulas ?? [],
    stage: t.stage ?? null,
  }));
}

export async function loadExamAttempts(userId: string, examId: string): Promise<ProgressAttempt[]> {
  const { data, error } = await serviceDb()
    .from("polya_practice_attempts")
    .select("question_id, topic_id, topic_ids, score, all_correct, created_at")
    .eq("exam_id", examId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(`Couldn't load practice history: ${error.message}`);
  return parseRows(attemptRow, data);
}

/** Everything a hand-off and exam_prep need for one exam. Null when the exam isn't the student's. */
export async function loadExamFacts(userId: string, examId: string, now: Date, timezone: string): Promise<ExamFacts | null> {
  const db = serviceDb();
  const { data: exam, error } = await db
    .from("polya_exams")
    .select("id, course_id, title, exam_date, plan")
    .eq("id", examId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Couldn't load that exam: ${error.message}`);
  const row = z
    .object({ id: z.string(), course_id: z.string(), title: z.string(), exam_date: z.string().nullable(), plan: z.unknown() })
    .safeParse(exam);
  if (!row.success) return null;

  const [names, topics, attempts, errors, mocks] = await Promise.all([
    courseNames(userId, [row.data.course_id]),
    loadExamTopics(userId, examId),
    loadExamAttempts(userId, examId),
    // The mistake log and mock exams are extras: the facts still load without them.
    db
      .from("polya_study_errors")
      .select("id, topic_id, what, fix, created_at")
      .eq("exam_id", examId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(200),
    db.from("polya_mock_exams").select("status, score").eq("exam_id", examId).eq("user_id", userId).limit(50),
  ]);

  const stages = stagesByTopic(topics, attempts, now.getTime());
  const titleOf = new Map(topics.map((t) => [t.id, t.title]));
  const ordered = orderTopics(
    topics.map((t) => {
      const info = stages.get(t.id);
      return {
        position: t.position,
        title: t.title,
        stage: info?.stage ?? "not_started",
        accuracy: info?.progress.accuracy ?? null,
        keyFormulas: t.keyFormulas,
      };
    }),
  );

  const openMistakes = errorStatus(parseRows(errorRow, errors.data), attempts)
    .filter((e) => !e.fixed)
    .map((e) => ({ topic: e.topic_id ? titleOf.get(e.topic_id) ?? null : null, what: e.what, fix: e.fix }));

  const plan = planShape.safeParse(row.data.plan);
  const today = localDate(now, timezone);
  const todayPlan = plan.success
    ? (plan.data.days.find((day) => day.date === today)?.items ?? []).filter((item) => !item.done).map((item) => item.text)
    : [];

  const handedIn = parseRows(z.object({ status: z.string(), score: z.number().nullable() }), mocks.data).filter(
    (m) => m.status === "submitted" && m.score !== null,
  );

  return {
    examId: row.data.id,
    title: row.data.title,
    courseName: names.get(row.data.course_id) ?? null,
    examDate: row.data.exam_date ?? "",
    topics: ordered,
    mistakes: openMistakes,
    todayPlan,
    mocksHandedIn: handedIn.length,
    bestMockScore: handedIn.length > 0 ? Math.max(...handedIn.map((m) => m.score!)) : null,
  };
}

const questionRow = z.object({
  id: z.string(),
  topic_id: z.string(),
  status: z.string(),
  origin: z.string().nullable().optional(),
  created_at: z.string(),
});

/** The exam's questions, for picking what to practice (no stems, parts, or keys). */
export async function loadExamQuestions(userId: string, examId: string): Promise<ProgressQuestion[]> {
  const { data, error } = await serviceDb()
    .from("polya_practice_questions")
    .select("id, topic_id, status, origin, created_at")
    .eq("exam_id", examId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`Couldn't load practice questions: ${error.message}`);
  return parseRows(questionRow, data);
}

/** One of the student's practice questions as text practice shows it, or null when it isn't theirs. */
export async function loadPracticeQuestion(
  userId: string,
  questionId: string,
): Promise<(PracticeQuestion & { readonly topicId: string; readonly examId: string }) | null> {
  const { data, error } = await serviceDb()
    .from("polya_practice_questions")
    .select("id, exam_id, topic_id, stem, parts, hide_topic, status")
    .eq("id", questionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Couldn't load that question: ${error.message}`);
  const row = z
    .object({
      id: z.string(),
      exam_id: z.string(),
      topic_id: z.string(),
      stem: z.string(),
      parts: z.array(z.record(z.string(), z.unknown())),
      hide_topic: z.boolean().nullable().optional(),
      status: z.string(),
    })
    .safeParse(data);
  if (!row.success || row.data.status !== "active") return null;
  return {
    id: row.data.id,
    examId: row.data.exam_id,
    topicId: row.data.topic_id,
    stem: row.data.stem,
    parts: row.data.parts as unknown as PublicPart[],
    hideTopic: row.data.hide_topic === true,
  };
}

/** Question ids held by the student's mock exams that aren't handed in yet: never served early. */
export async function loadReservedQuestionIds(userId: string): Promise<Set<string>> {
  const { data, error } = await serviceDb()
    .from("polya_mock_exams")
    .select("question_ids")
    .eq("user_id", userId)
    .in("status", ["building", "ready", "in_progress"]);
  if (error) throw new Error(`Couldn't load mock exams: ${error.message}`);
  const ids = new Set<string>();
  for (const row of parseRows(z.object({ question_ids: z.array(z.string()).nullable() }), data)) {
    for (const id of row.question_ids ?? []) ids.add(id);
  }
  return ids;
}

async function courseNames(userId: string, courseIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(courseIds)];
  if (ids.length === 0) return new Map();
  const { data, error } = await serviceDb().from("polya_courses").select("id, name").eq("user_id", userId).in("id", ids);
  if (error) return new Map();
  return new Map(parseRows(z.object({ id: z.string(), name: z.string() }), data).map((c) => [c.id, c.name]));
}
