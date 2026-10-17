import { redirect } from "next/navigation";

import { getAuthenticatedAppUser } from "@/lib/auth/session";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import CourseHeader from "@/components/course/CourseHeader";
import MockRunner from "@/components/mock/MockRunner";
import { minutesSince, type MockReport, type MockReview, type ReviewQuestion } from "@/lib/mock-exam";
import type { MockRow } from "@/lib/study";

export const metadata = { title: "Mock exam" };

interface MockPageRow {
  id: string;
  exam_id: string;
  title: string;
  minutes: number;
  spec: { question_count?: number } | null;
  question_ids: string[];
  status: MockRow["status"];
  started_at: string | null;
  report: MockReport | null;
}

// A handed-in mock's review, read under RLS: its questions, the attempts it
// recorded, and the keys those attempts unlocked.
async function loadReview(
  supabase: Awaited<ReturnType<typeof getAuthenticatedAppUser>>["supabase"],
  mock: MockPageRow,
): Promise<MockReview | null> {
  if (!mock.report || mock.question_ids.length === 0) return null;
  const [questions, attempts, keys] = await Promise.all([
    supabase.from("polya_practice_questions").select("id, topic_id, topic_ids, stem, parts, sources").in("id", mock.question_ids),
    supabase
      .from("polya_practice_attempts")
      .select("id, question_id, responses, results, score, all_correct")
      .eq("mock_id", mock.id),
    supabase.from("polya_practice_keys").select("question_id, answers, explanation").in("question_id", mock.question_ids),
  ]);
  if (questions.error || attempts.error || keys.error) return null;
  const questionBy = new Map(((questions.data ?? []) as Omit<ReviewQuestion, "attempt" | "key">[]).map((q) => [q.id, q]));
  const attemptBy = new Map(((attempts.data ?? []) as NonNullable<ReviewQuestion["attempt"]>[]).map((a) => [a.question_id, a]));
  const keyBy = new Map(((keys.data ?? []) as NonNullable<ReviewQuestion["key"]>[]).map((k) => [k.question_id, k]));
  return {
    report: mock.report,
    questions: mock.question_ids.flatMap((id) => {
      const question = questionBy.get(id);
      return question ? [{ ...question, attempt: attemptBy.get(id) ?? null, key: keyBy.get(id) ?? null }] : [];
    }),
  };
}

// A server render runs once per request, so reading the clock here is fine.
function minutesIn(startedAt: string | null): number {
  return startedAt ? minutesSince(startedAt, Date.now()) : 0;
}

export default async function MockPage({ params }: { params: Promise<{ id: string; examId: string; mockId: string }> }) {
  const { user, supabase, outage } = await getAuthenticatedAppUser();
  if (outage) throw new Error("auth-outage");
  if (!user) return redirectToLogin();
  const { id, examId, mockId } = await params;

  const [course, exam, mock, topics] = await Promise.all([
    supabase.from("polya_courses").select("name").eq("id", id).maybeSingle(),
    supabase.from("polya_exams").select("id, title").eq("id", examId).eq("course_id", id).maybeSingle(),
    supabase
      .from("polya_mock_exams")
      .select("id, exam_id, title, minutes, spec, question_ids, status, started_at, report")
      .eq("id", mockId)
      .eq("exam_id", examId)
      .maybeSingle(),
    supabase.from("polya_study_topics").select("id, title").eq("exam_id", examId).order("position", { ascending: true }),
  ]);

  // A failed load shows the retry notice, not an empty mock.
  if (course.error || exam.error || mock.error) throw new Error("study-unavailable");
  if (!course.data) redirect("/app");
  if (!exam.data) redirect(`/app/courses/${id}/study`);
  if (!mock.data) redirect(`/app/courses/${id}/study/${examId}`);

  const row = mock.data as MockPageRow;
  const review = row.status === "submitted" ? await loadReview(supabase, row) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CourseHeader courseId={id} courseName={course.data.name} />
      <MockRunner
        courseId={id}
        examId={examId}
        examTitle={exam.data.title as string}
        userId={user.id}
        mock={{
          id: row.id,
          title: row.title,
          minutes: row.minutes,
          status: row.status,
          questionCount: row.spec?.question_count ?? row.question_ids.length,
        }}
        minutesIn={minutesIn(row.started_at)}
        topics={(topics.data ?? []) as { id: string; title: string }[]}
        review={review}
      />
    </div>
  );
}
