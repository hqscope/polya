import { redirect } from "next/navigation";

import { getAuthenticatedAppUser } from "@/lib/auth/session";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import CourseHeader from "@/components/course/CourseHeader";
import CoachView from "@/components/coach/CoachView";
import type { CardState } from "@/components/coach/CoachThread";
import { gradedFromRows, questionIdsIn, toCoachMessages, type AttemptForCard, type StoredMessage } from "@/lib/coach";
import type { TutorSource } from "@/lib/sse";
import type {
  AttemptRow,
  CourseFile,
  GradedAttempt,
  ExamFileMark,
  ExamRow,
  MockRow,
  QuestionRow,
  StudyErrorRow,
  TopicRow,
} from "@/lib/study";

export const metadata = { title: "Study" };

const THREAD_LIMIT = 100;

export default async function ExamPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; examId: string }>;
  searchParams: Promise<{ review?: string | string[] }>;
}) {
  const { user, supabase, outage } = await getAuthenticatedAppUser();
  if (outage) throw new Error("auth-outage");
  if (!user) return redirectToLogin();
  const { id, examId } = await params;
  const { review } = await searchParams;

  const [course, exam, topics, questions, attempts, marks, files, conversation, errors, mocks] = await Promise.all([
    supabase.from("polya_courses").select("name").eq("id", id).maybeSingle(),
    supabase
      .from("polya_exams")
      .select("id, course_id, title, exam_date, scope_note, examples_note, plan")
      .eq("id", examId)
      .eq("course_id", id)
      .maybeSingle(),
    supabase
      .from("polya_study_topics")
      .select("id, position, title, summary, key_formulas, source_ids, origin, stage")
      .eq("exam_id", examId)
      .order("position", { ascending: true }),
    supabase
      .from("polya_practice_questions")
      .select("id, topic_id, topic_ids, stem, parts, sources, status, origin, hide_topic, created_at")
      .eq("exam_id", examId)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("polya_practice_attempts")
      .select("id, question_id, topic_id, topic_ids, score, all_correct, created_at")
      .eq("exam_id", examId)
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase.from("polya_exam_sources").select("source_id, kind").eq("exam_id", examId),
    supabase
      .from("polya_sources")
      .select("id, title, status")
      .eq("course_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("polya_conversations")
      .select("id")
      .eq("exam_id", examId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("polya_study_errors")
      .select("id, topic_id, question_id, what, why, fix, created_at")
      .eq("exam_id", examId)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("polya_mock_exams")
      .select("id, title, minutes, status, question_ids, started_at, due_at, submitted_at, score, created_at")
      .eq("exam_id", examId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  // A failed load shows the retry notice, not an empty exam.
  if (course.error || exam.error || topics.error || questions.error || attempts.error || conversation.error) {
    throw new Error("study-unavailable");
  }
  if (!course.data) redirect("/app");
  if (!exam.data) redirect(`/app/courses/${id}/study`);
  // The mistake log and mock exams are extras: the coach still opens without them.
  if (errors.error) console.warn("[polya] mistakes didn't load:", errors.error.message);
  if (mocks.error) console.warn("[polya] mock exams didn't load:", mocks.error.message);

  // The coach thread, newest 100 rows in order, and every card in it rebuilt
  // with its latest answer and the key that answer unlocked.
  const conversationId = (conversation.data?.id as string | undefined) ?? null;
  let initialMessages: ReturnType<typeof toCoachMessages> = [];
  let initialCards: Record<string, CardState> = {};
  if (conversationId) {
    const { data: rows } = await supabase
      .from("polya_messages")
      .select("id, role, content, sources, blocks, meta")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(THREAD_LIMIT);
    initialMessages = toCoachMessages(((rows ?? []) as StoredMessage[]).reverse());
    const ids = questionIdsIn(initialMessages);
    if (ids.length > 0) {
      const [cardAttempts, keys, sourceRows] = await Promise.all([
        supabase
          .from("polya_practice_attempts")
          .select("question_id, responses, results, score, all_correct, created_at")
          .in("question_id", ids),
        supabase.from("polya_practice_keys").select("question_id, answers, explanation").in("question_id", ids),
        supabase.from("polya_practice_questions").select("id, sources").in("id", ids),
      ]);
      const sourcesBy = new Map(((sourceRows.data ?? []) as { id: string; sources: TutorSource[] }[]).map((q) => [q.id, q.sources ?? []]));
      const rebuilt = gradedFromRows(
        (cardAttempts.data ?? []) as AttemptForCard[],
        (keys.data ?? []) as { question_id: string; answers: GradedAttempt["answers"]; explanation: string }[],
        (questionId) => sourcesBy.get(questionId) ?? [],
      );
      initialCards = Object.fromEntries(rebuilt);
    }
  }

  const reviewMockId = typeof review === "string" ? review : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CourseHeader courseId={id} courseName={course.data.name} />
      <CoachView
        courseId={id}
        exam={exam.data as ExamRow}
        topics={(topics.data ?? []) as TopicRow[]}
        questions={(questions.data ?? []) as QuestionRow[]}
        attempts={(attempts.data ?? []) as AttemptRow[]}
        marks={(marks.data ?? []) as ExamFileMark[]}
        files={(files.data ?? []) as CourseFile[]}
        errors={(errors.data ?? []) as StudyErrorRow[]}
        mocks={(mocks.data ?? []) as MockRow[]}
        conversationId={conversationId}
        initialMessages={initialMessages}
        initialCards={initialCards}
        reviewMockId={reviewMockId}
      />
    </div>
  );
}
