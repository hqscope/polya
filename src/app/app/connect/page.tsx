import { getAuthenticatedAppUser } from "@/lib/auth/session";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import ConnectFlow from "@/components/import/ConnectFlow";
import CourseSiteImport from "@/components/import/CourseSiteImport";
import type { SiteCourseOption } from "@/lib/course-site-match";

export const metadata = { title: "Add a course" };

export default async function ConnectPage() {
  const { user, supabase, outage } = await getAuthenticatedAppUser();
  if (outage) {
    throw new Error("auth-outage");
  }
  if (!user) {
    return redirectToLogin();
  }

  // Offered in the website form so a class's website joins its Canvas course.
  const { data: courseRows } = await supabase
    .from("polya_courses")
    .select("id, name, code")
    .order("created_at", { ascending: false });
  const courses: SiteCourseOption[] = (courseRows ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    code: (row.code as string | null) ?? null,
  }));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[560px] flex-col gap-6 px-5 pt-10 pb-14 sm:px-8">
        <div className="flex flex-col gap-1.5 border-b border-line pb-[18px]">
          <h1 className="text-[21px]">Add a course</h1>
          <p className="m-0 text-[13px] leading-[1.65] text-ink2">
            Polya studies your course materials so its help always comes from
            what your class actually covers. Bring a course in from Canvas, from
            its own website, or both.{" "}
            <a href="#course-website" className="underline-offset-2 hover:underline">
              Add a course website ↓
            </a>
          </p>
        </div>

        <ConnectFlow />

        <div id="course-website" className="scroll-mt-6 border-t border-line pt-6">
          <CourseSiteImport courses={courses} />
        </div>
      </div>
    </div>
  );
}
