"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { courseTab, type CourseTab } from "@/lib/app-nav";

const POLICY_CHIP: Record<string, [string, string]> = {
  open: ["Open", "full answers on request"],
  guided: ["Guided", "hints first"],
  practice: ["Practice", "commit before reveal"],
  review: ["Review", "full solutions"],
};

const TABS: { tab: CourseTab; label: string; suffix: string }[] = [
  { tab: "chat", label: "Chat", suffix: "" },
  { tab: "study", label: "Study", suffix: "/study" },
  { tab: "materials", label: "Materials", suffix: "/materials" },
];

interface Props {
  courseId: string;
  courseName: string;
  /** The course's study mode; the chip shows only when it's given. */
  policyMode?: string;
  /** Page-specific buttons on the right (e.g. "New conversation"). */
  actions?: ReactNode;
}

// The course's top bar on every course page: where you are, the study-mode
// chip, and the Chat · Study · Materials tabs. On phones the tabs drop to a
// second row so the course name keeps its room.
export default function CourseHeader({ courseId, courseName, policyMode, actions }: Props) {
  const pathname = usePathname();
  const active = courseTab(pathname, courseId);
  const base = `/app/courses/${courseId}`;
  const chip = policyMode ? (POLICY_CHIP[policyMode] ?? POLICY_CHIP.guided) : null;

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-2.5 border-b border-line px-3 sm:px-[18px]">
      <div className="flex h-[46px] min-w-0 flex-1 items-center gap-2.5">
        <Link href="/app" className="hidden shrink-0 text-[13px] text-ink3 hover:text-ink sm:inline">
          My courses
        </Link>
        <span className="hidden text-[13px] text-ink3 sm:inline">/</span>
        <h1 className="m-0 truncate text-[13.5px] font-semibold tracking-[-0.01em]">{courseName}</h1>
        {chip ? (
          <Link
            href={`${base}/materials`}
            title="Set for this course — see the materials page"
            className="shrink-0 rounded bg-accent-soft px-2 py-[3px] text-[10px] font-[650] uppercase tracking-[0.07em] text-accent-ink hover:text-accent-ink"
          >
            {chip[0]}
            <span className="hidden lg:inline"> · {chip[1]}</span>
          </Link>
        ) : null}
      </div>

      <nav
        aria-label="Course sections"
        className="order-last -mx-1 flex h-9 w-full items-stretch gap-1 md:order-none md:mx-0 md:h-[46px] md:w-auto"
      >
        {TABS.map(({ tab, label, suffix }) => {
          const current = active === tab;
          return (
            <Link
              key={tab}
              href={`${base}${suffix}`}
              aria-current={current ? "page" : undefined}
              className={`flex items-center border-b-2 px-2 text-[13px] ${
                current
                  ? "border-accent font-semibold text-ink"
                  : "border-transparent text-ink3 hover:text-ink"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {actions ? <div className="flex h-[46px] shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
