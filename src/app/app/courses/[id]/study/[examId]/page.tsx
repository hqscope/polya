import { redirect } from "next/navigation";

import { getAuthenticatedAppUser } from "@/lib/auth/session";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import CourseHeader from "@/components/course/CourseHeader";
import ExamWorkspace from "@/components/study/ExamWorkspace";
import type {
  AttemptRow,
  CourseFile,
  ExamFileMark,
  ExamRow,
  QuestionRow,
  TopicRow,
} from "@/lib/study";

export const metadata = { title: "Study" };

export default async function ExamPage({ params }: { params: Promise<{ id: string; examId: string }> }) {
  const { user, supabase, outage } = await getAuthenticatedAppUser();
  if (outage) throw new Error("auth-outage");
  if (!user) return redirectToLogin();
  const { id, examId } = await params;

  const [course, exam, topics, questions, attempts, marks, files] = await Promise.all([
    supabase.from("polya_courses").select("name").eq("id", id).maybeSingle(),
    supabase
      .from("polya_exams")
      .select("id, course_id, title, exam_date, scope_note, examples_note")
      .eq("id", examId)
      .eq("course_id", id)
      .maybeSingle(),
    supabase
      .from("polya_study_topics")
      .select("id, position, title, summary, key_formulas, source_ids, origin")
      .eq("exam_id", examId)
      .order("position", { ascending: true }),
    supabase
      .from("polya_practice_questions")
      .select("id, topic_id, stem, parts, sources, status, created_at")
      .eq("exam_id", examId)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("polya_practice_attempts")
      .select("question_id, topic_id, score, all_correct, created_at")
      .eq("exam_id", examId)
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase.from("polya_exam_sources").select("source_id, kind").eq("exam_id", examId),
    supabase
      .from("polya_sources")
      .select("id, title, status")
      .eq("course_id", id)
      .order("created_at", { ascending: true }),
  ]);

  // A failed load shows the retry notice, not an empty exam.
  if (course.error || exam.error || topics.error || questions.error || attempts.error) {
    throw new Error("study-unavailable");
  }
  if (!course.data) redirect("/app");
  if (!exam.data) redirect(`/app/courses/${id}/study`);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CourseHeader courseId={id} courseName={course.data.name} />
      <ExamWorkspace
        courseId={id}
        exam={exam.data as ExamRow}
        topics={(topics.data ?? []) as TopicRow[]}
        questions={(questions.data ?? []) as QuestionRow[]}
        attempts={(attempts.data ?? []) as AttemptRow[]}
        marks={(marks.data ?? []) as ExamFileMark[]}
        files={(files.data ?? []) as CourseFile[]}
      />
    </div>
  );
}
