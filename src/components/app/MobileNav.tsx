"use client";

import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import Logo from "@/components/Logo";
import SidebarNav, { type SidebarCourse } from "@/components/app/SidebarNav";
import ImportsIndicator from "@/components/app/ImportsIndicator";
import AccountBlock from "@/components/app/AccountBlock";
import { currentPlaceLabel } from "@/lib/app-nav";

// The sidebar's stand-in below the `md` breakpoint (phones, narrow windows):
// a compact top bar whose menu holds everything the sidebar does — My courses,
// Connect Canvas, the course list, imports in progress, and Sign out.
export default function MobileNav({
  courses,
  displayName,
  email,
}: {
  courses: SidebarCourse[];
  displayName: string;
  email: string;
}) {
  const pathname = usePathname();
  // The menu belongs to the page it was opened on, so following any link in
  // it (or the browser's back button) closes it without an effect.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpenOn(null);
      buttonRef.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="relative z-30 flex h-12 shrink-0 items-center gap-3 px-4 md:hidden">
      <Logo href="/app" />

      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpenOn(open ? null : pathname)}
        className="ml-auto flex h-9 min-w-0 max-w-[65%] cursor-pointer items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink shadow-card"
      >
        <span className="truncate">{currentPlaceLabel(pathname, courses)}</span>
        <span className="sr-only">, menu</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className={`h-3 w-3 shrink-0 text-ink3 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            d="M2.5 4.5 6 8l3.5-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <>
          <div
            aria-hidden="true"
            onClick={() => setOpenOn(null)}
            className="fixed inset-x-0 top-12 bottom-0 bg-ink/20"
          />
          <div
            id={panelId}
            className="absolute inset-x-2 top-12 flex max-h-[calc(100dvh-4rem)] animate-fade-up flex-col rounded-[10px] border border-line bg-bg px-3 pb-3.5 shadow-[0_18px_40px_-20px_rgba(25,31,29,0.45)]"
          >
            <SidebarNav courses={courses} />
            <div className="flex shrink-0 flex-col gap-3 pt-4">
              <ImportsIndicator />
              <AccountBlock displayName={displayName} email={email} />
            </div>
          </div>
        </>
      ) : null}
    </header>
  );
}
