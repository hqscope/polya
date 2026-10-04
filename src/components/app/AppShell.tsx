import Logo from "@/components/Logo";
import SidebarNav, { type SidebarCourse } from "@/components/app/SidebarNav";
import ImportsIndicator from "@/components/app/ImportsIndicator";
import ActivityReporter from "@/components/app/ActivityReporter";
import AccountBlock from "@/components/app/AccountBlock";
import MobileNav from "@/components/app/MobileNav";

// The signed-in frame: sidebar from `md` up, a compact top bar below it, and
// the page card. Auth and data loading stay in `app/app/layout.tsx`.
export default function AppShell({
  displayName,
  email,
  courses,
  children,
}: {
  displayName: string;
  email: string;
  courses: SidebarCourse[];
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      <ActivityReporter />
      <MobileNav courses={courses} displayName={displayName} email={email} />

      <aside className="hidden w-[216px] shrink-0 flex-col px-3 pt-4 pb-3.5 md:flex">
        <Logo href="/app" className="px-2.5 py-0.5" />

        <SidebarNav courses={courses} />

        <div className="mt-auto flex flex-col gap-3 pt-3">
          <ImportsIndicator />
          <AccountBlock displayName={displayName} email={email} />
        </div>
      </aside>

      <main className="min-h-0 min-w-0 flex-1 px-2 pb-2 md:p-2 md:pl-0">
        <div className="flex h-full flex-col overflow-hidden rounded-[10px] border border-line bg-surface shadow-card">
          {children}
        </div>
      </main>
    </div>
  );
}
