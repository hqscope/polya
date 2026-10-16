import Link from "next/link";
import { redirect } from "next/navigation";

import { getAuthenticatedAppUser } from "@/lib/auth/session";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import CourseHeader from "@/components/course/CourseHeader";
import ExamForm from "@/components/study/ExamForm";
import { examDateLabel, type CourseFile } from "@/lib/study";

export const metadata = { title: "Study" };

export default async function StudyPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, supabase, outage } = await getAuthenticatedAppUser();
  if (outage) throw new Error("auth-outage");
  if (!user) return redirectToLogin();
  const { id } = await params;

  const [{ data: course, error: courseError }, { data: exams, error: examsError }, { data: files }, { data: topics }] =
    await Promise.all([
      supabase.from("polya_courses").select("name").eq("id", id).maybeSingle(),
      supabase
        .from("polya_exams")
        .select("id, title, exam_date, created_at")
        .eq("course_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .from("polya_sources")
        .select("id, title, status")
        .eq("course_id", id)
        .order("created_at", { ascending: true }),
      supabase.from("polya_study_topics").select("exam_id"),
    ]);
  if (courseError || examsError) throw new Error("study-unavailable");
  if (!course) redirect("/app");

  const topicCount = new Map<string, number>();
  for (const row of (topics ?? []) as { exam_id: string }[]) {
    topicCount.set(row.exam_id, (topicCount.get(row.exam_id) ?? 0) + 1);
  }
  const examRows = (exams ?? []) as { id: string; title: string; exam_date: string | null }[];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CourseHeader courseId={id} courseName={course.name} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[640px] flex-col gap-7 px-5 pt-9 pb-14 sm:px-8">
          <div className="flex flex-col gap-[7px] border-b border-line pb-[18px]">
            <h2 className="text-[21px]">Prepare for an exam</h2>
            <p className="m-0 text-[13px] leading-[1.65] text-ink2">
              Add an exam and Polya maps out its topics from your course, then gives you practice questions in
              the style of your instructor&apos;s. You answer first; then you see a worked solution with the
              pages it comes from. Topics you&apos;re shaky on come back until they stick.
            </p>
          </div>

          {examRows.length > 0 ? (
            <section className="flex flex-col gap-2.5">
              <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">Your exams</span>
              <div className="flex flex-col rounded-[9px] border border-line-soft bg-rail px-3.5 py-0.5">
                {examRows.map((exam) => {
                  const when = examDateLabel(exam.exam_date);
                  const count = topicCount.get(exam.id) ?? 0;
                  return (
                    <Link
                      key={exam.id}
                      href={`/app/courses/${id}/study/${exam.id}`}
                      className="flex items-center justify-between gap-3.5 border-b border-line-soft py-[11px] last:border-b-0 hover:text-ink"
                    >
                      <span className="min-w-0 truncate text-[13.5px] font-semibold">{exam.title}</span>
                      <span className="shrink-0 text-[11.5px] text-ink3">
                        {[when, count > 0 ? `${count} topic${count === 1 ? "" : "s"}` : "No topics yet"]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>
          ) : null}

          <section className="flex flex-col gap-3 border-t border-line pt-6">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">New exam</span>
              <h3 className="text-[15.5px] tracking-[-0.015em]">What are you studying for?</h3>
            </div>
            <ExamForm courseId={id} files={(files ?? []) as CourseFile[]} />
          </section>
        </div>
      </div>
    </div>
  );
}
