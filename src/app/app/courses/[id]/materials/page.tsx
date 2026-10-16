import { redirect } from "next/navigation";

import { getAuthenticatedAppUser } from "@/lib/auth/session";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import {
  sourceKindBadge,
  sourceStatusClass,
  sourceStatusLabel,
} from "@/lib/sources";
import PolicyPanel from "@/components/policy/PolicyPanel";
import RefreshMaterials from "@/components/import/RefreshMaterials";
import MaterialUpload from "@/components/import/MaterialUpload";
import CourseSiteImport from "@/components/import/CourseSiteImport";
import CourseHeader from "@/components/course/CourseHeader";

export const metadata = { title: "Course materials" };

type Mode = "open" | "guided" | "practice" | "review";

export default async function MaterialsPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, supabase, outage } = await getAuthenticatedAppUser();
  if (outage) {
    throw new Error("auth-outage");
  }
  if (!user) {
    return redirectToLogin();
  }
  const { id } = await params;

  const [
    { data: course, error: courseError },
    { data: sources, error: sourcesError },
    { data: policy },
    { data: checks },
  ] =
    await Promise.all([
      supabase
        .from("polya_courses")
        .select("name, canvas_course_id, connection_id, site_url")
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("polya_sources")
        .select("id, title, origin, source_kind, status, chunks_embedded")
        .eq("course_id", id)
        .order("created_at", { ascending: true }),
      supabase
        .from("polya_course_policies")
        .select("mode, instructor_note")
        .eq("course_id", id)
        .maybeSingle(),
      supabase
        .from("polya_mastery_checks")
        .select("id, concept, verdict, status, created_at")
        .eq("course_id", id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

  // A failed load shows the retry notice, not an empty or missing course.
  if (courseError || sourcesError) throw new Error("materials-unavailable");
  if (!course) redirect("/app");

  // Website-only courses are keyed "site:<address>" and have nothing in Canvas to re-check.
  const canvasCourseId = String(course.canvas_course_id ?? "");
  const fromCanvas =
    canvasCourseId !== "" && !canvasCourseId.startsWith("fixture-") && !canvasCourseId.startsWith("site:");

  const total = (sources ?? []).length;
  const ready = (sources ?? []).filter((s) => s.status === "ready").length;
  const completedChecks = (checks ?? []).filter((c) => c.status === "completed");
  const passedChecks = completedChecks.filter((c) => c.verdict === "pass").length;
  const verdictLabel: Record<string, string> = {
    pass: "Got it",
    partial: "Close",
    fail: "Not yet",
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CourseHeader courseId={id} courseName={course.name} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[640px] flex-col gap-7 px-5 pt-9 pb-14 sm:px-8">
          <div className="flex flex-col gap-[7px] border-b border-line pb-[18px]">
            <h2 className="text-[21px]">Course materials &amp; policy</h2>
            <p className="m-0 text-[13px] text-ink2">
              {course.name} · {ready} of {total} source{total === 1 ? "" : "s"}{" "}
              ready
            </p>
          </div>

          <PolicyPanel
            courseId={id}
            initialMode={(policy?.mode as Mode) ?? "guided"}
            initialNote={policy?.instructor_note ?? null}
          />

          <div className="border-t border-line pt-6">
            <CourseSiteImport courseId={id} siteUrl={(course.site_url as string | null) ?? null} />
          </div>

          <div className="border-t border-line pt-6">
            <MaterialUpload courseId={id} />
          </div>

          {completedChecks.length > 0 ? (
            <section className="flex flex-col gap-2.5 border-t border-line pt-6">
              <div className="flex items-baseline gap-2.5">
                <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">
                  Check-yourself record
                </span>
                <span className="text-[11.5px] text-ink3">
                  {passedChecks} of {completedChecks.length} solved on your own
                </span>
              </div>
              <div className="flex flex-col rounded-[9px] border border-line-soft bg-rail px-3.5 py-0.5">
                {completedChecks.map((check) => (
                  <div
                    key={check.id}
                    className="flex items-center justify-between gap-3.5 border-b border-line-soft py-[9px] last:border-b-0"
                  >
                    <span className="truncate text-[13px]">{check.concept}</span>
                    <span
                      className={`shrink-0 text-[11px] font-semibold ${
                        check.verdict === "pass" ? "text-accent-ink" : "text-amber"
                      }`}
                    >
                      {verdictLabel[check.verdict ?? ""] ?? "—"}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="flex flex-col gap-2.5 border-t border-line pt-6">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">
                Everything Polya is studying
              </span>
              {fromCanvas ? (
                <RefreshMaterials
                  canvasCourseId={canvasCourseId}
                  connectionId={(course.connection_id as string | null) ?? null}
                />
              ) : null}
            </div>
            <div className="flex flex-col rounded-[9px] border border-line-soft bg-rail px-3.5 py-0.5">
              {(sources ?? []).map((source) => (
                <div
                  key={source.id}
                  className="flex items-center justify-between gap-3.5 border-b border-line-soft py-[9px] last:border-b-0"
                >
                  <span className="flex min-w-0 items-center gap-[9px]">
                    <span className="shrink-0 rounded border border-line bg-surface px-[5px] py-px font-mono text-[9.5px] uppercase text-ink3">
                      {sourceKindBadge(source.source_kind, source.origin)}
                    </span>
                    <span className="truncate text-[13px]">{source.title}</span>
                  </span>
                  <span
                    className={`shrink-0 text-[11px] font-semibold ${sourceStatusClass(source.status)}`}
                  >
                    {sourceStatusLabel(source.status)}
                  </span>
                </div>
              ))}
              {total === 0 ? (
                <p className="m-0 py-[9px] text-[12.5px] text-ink3">
                  Nothing here yet — connect Canvas, add your course website, or
                  upload your own files to get started.
                </p>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
