import Link from "next/link";
import { redirect } from "next/navigation";

import { getAuthenticatedAppUser } from "@/lib/auth/session";
import {
  sourceKindBadge,
  sourceStatusClass,
  sourceStatusLabel,
} from "@/lib/sources";
import PolicyPanel from "@/components/policy/PolicyPanel";
import RefreshMaterials from "@/components/import/RefreshMaterials";
import TranscriptUpload from "@/components/import/TranscriptUpload";

export const metadata = { title: "Course materials" };

type Mode = "open" | "guided" | "practice" | "review";

export default async function MaterialsPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, supabase } = await getAuthenticatedAppUser();
  if (!user) {
    redirect("/login?next=/app");
  }
  const { id } = await params;

  const [{ data: course }, { data: sources }, { data: policy }, { data: checks }] =
    await Promise.all([
      supabase.from("polya_courses").select("name, canvas_course_id").eq("id", id).maybeSingle(),
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

  if (!course) redirect("/app");

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
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[640px] flex-col gap-7 px-8 pt-9 pb-14">
        <div className="flex flex-col gap-[7px] border-b border-line pb-[18px]">
          <Link
            href={`/app/courses/${id}`}
            className="self-start text-[12.5px] text-ink3 hover:text-ink"
          >
            ← Back to study
          </Link>
          <h1 className="text-[21px]">Course materials &amp; policy</h1>
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
          <TranscriptUpload courseId={id} />
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
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">
              Everything Polya is studying
            </span>
            {course.canvas_course_id &&
            !String(course.canvas_course_id).startsWith("fixture-") ? (
              <RefreshMaterials
                courseId={id}
                canvasCourseId={String(course.canvas_course_id)}
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
                Nothing here yet — connect Canvas or upload a transcript to get
                started.
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
