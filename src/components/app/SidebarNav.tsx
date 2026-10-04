"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { courseNavLabel, isCoursePath, type NavCourse } from "@/lib/app-nav";

export type SidebarCourse = NavCourse;

function NavItem({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`shrink-0 truncate rounded-md border px-2.5 py-1.5 text-[13px] leading-[1.45] font-medium ${
        active
          ? "border-line bg-surface text-ink shadow-card"
          : "border-transparent text-ink2 hover:bg-line-soft hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}

export default function SidebarNav({ courses }: { courses: SidebarCourse[] }) {
  const pathname = usePathname();

  return (
    <>
      <nav className="mt-[18px] flex flex-col gap-px">
        <NavItem href="/app" active={pathname === "/app"}>
          My courses
        </NavItem>
        <NavItem href="/app/connect" active={pathname.startsWith("/app/connect")}>
          Connect Canvas
        </NavItem>
      </nav>

      {courses.length > 0 ? (
        <>
          <p className="mt-5 mb-1 px-2.5 text-[10.5px] font-[650] uppercase tracking-[0.09em] text-ink3">
            Courses
          </p>
          <nav className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
            {courses.map((course) => (
              <NavItem
                key={course.id}
                href={`/app/courses/${course.id}`}
                active={isCoursePath(pathname, course.id)}
              >
                {courseNavLabel(course)}
              </NavItem>
            ))}
          </nav>
        </>
      ) : null}
    </>
  );
}
