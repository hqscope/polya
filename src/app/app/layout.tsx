import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getAuthenticatedAppUser } from "@/lib/auth/session";
import Logo from "@/components/Logo";
import SidebarNav, { type SidebarCourse } from "@/components/app/SidebarNav";
import ImportsIndicator from "@/components/app/ImportsIndicator";

export const metadata: Metadata = {
  title: {
    default: "Study",
    template: "%s | Polya",
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, supabase } = await getAuthenticatedAppUser();

  if (!user) {
    redirect("/login?next=/app");
  }

  const { data: courses } = await supabase
    .from("polya_courses")
    .select("id, name, code")
    .order("created_at", { ascending: false });

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-[216px] shrink-0 flex-col px-3 pt-4 pb-3.5 md:flex">
        <Logo href="/app" className="px-2.5 py-0.5" />

        <SidebarNav courses={(courses ?? []) as SidebarCourse[]} />

        <div className="mt-auto flex flex-col gap-3 pt-3">
          <ImportsIndicator />

          <div className="flex flex-col border-t border-line px-2.5 pt-3">
            <p className="m-0 truncate text-[12.5px] font-semibold">
              {user.displayName}
            </p>
            <p className="m-0 truncate text-[11.5px] text-ink3">{user.email}</p>
            <form action="/auth/signout" method="post" className="mt-2">
              <button
                type="submit"
                className="cursor-pointer text-[12px] text-ink3 hover:text-ink"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-2 md:pl-0">
        <div className="flex h-full flex-col overflow-hidden rounded-[10px] border border-line bg-surface shadow-card">
          {children}
        </div>
      </main>
    </div>
  );
}
