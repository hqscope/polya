import Link from "next/link";
import { redirect } from "next/navigation";

import { getAuthenticatedAppUser } from "@/lib/auth/session";
import CourseCard from "@/components/app/CourseCard";

const TERMINAL_STATUSES = new Set(["ready", "failed", "skipped", "needs_ocr"]);

const POLICY_LABELS: Record<string, string> = {
  open: "Open",
  guided: "Guided",
  practice: "Practice",
  review: "Review",
};

export default async function AppHomePage() {
  const { user, supabase } = await getAuthenticatedAppUser();
  if (!user) {
    redirect("/login?next=/app");
  }

  const [{ data: courses }, { data: policies }, { data: sources }] =
    await Promise.all([
      supabase
        .from("polya_courses")
        .select("id, name, code, term_name")
        .order("created_at", { ascending: false }),
      supabase.from("polya_course_policies").select("course_id, mode"),
      supabase.from("polya_sources").select("course_id, status"),
    ]);

  if (!courses || courses.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center overflow-y-auto p-10 text-center">
        <p className="eyebrow">Welcome</p>
        <h1 className="mt-3 text-[21px]">Bring in your first course</h1>
        <p className="mt-3 max-w-md text-[13px] leading-[1.65] text-ink2">
          Connect your school&apos;s Canvas and Polya will study your course —
          the readings, slides, and pages — so its help always comes from what
          your class actually covers.
        </p>
        <Link href="/app/connect" className="button-primary mt-7">
          Connect Canvas
        </Link>
      </div>
    );
  }

  const policyByCourse = new Map(
    (policies ?? []).map((row) => [row.course_id as string, row.mode as string]),
  );
  const statsByCourse = new Map<
    string,
    { ready: number; total: number; importing: boolean }
  >();
  for (const row of sources ?? []) {
    const stats = statsByCourse.get(row.course_id) ?? {
      ready: 0,
      total: 0,
      importing: false,
    };
    stats.total += 1;
    if (row.status === "ready") stats.ready += 1;
    if (!TERMINAL_STATUSES.has(row.status)) stats.importing = true;
    statsByCourse.set(row.course_id, stats);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[860px] flex-col gap-[22px] px-9 pt-9 pb-12">
        <div className="flex items-end gap-4 border-b border-line pb-[18px]">
          <div className="flex flex-col gap-1">
            <h1 className="text-[21px]">Your courses</h1>
            <p className="m-0 text-[13px] text-ink2">
              Pick up where you left off.
            </p>
          </div>
          <Link
            href="/app/connect"
            className="button-primary ml-auto h-8 rounded-[7px] px-[13px] text-[12.5px]"
          >
            Add a course
          </Link>
        </div>

        <div className="grid gap-3.5 sm:grid-cols-2">
          {courses.map((course) => {
            const stats = statsByCourse.get(course.id);
            const mode = policyByCourse.get(course.id) ?? "guided";
            const importing = stats?.importing ?? false;
            const meta =
              [course.code, course.term_name].filter(Boolean).join(" · ") ||
              "Course";

            return (
              <CourseCard
                key={course.id}
                course={{
                  id: course.id,
                  name: course.name,
                  meta,
                  importing,
                  modeLabel: POLICY_LABELS[mode] ?? "Guided",
                  readyCount: stats?.ready ?? 0,
                  totalCount: stats?.total ?? 0,
                }}
              />
            );
          })}

          <Link
            href="/app/connect"
            className="flex min-h-[120px] flex-col items-center justify-center gap-[5px] rounded-[10px] border border-dashed border-line p-5 text-ink3 hover:border-ink3 hover:text-ink"
          >
            <span className="text-[17px] leading-none font-medium">+</span>
            <span className="text-[12.5px] font-semibold">
              Connect another course
            </span>
          </Link>
        </div>
      </div>
    </div>
  );
}
