"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { invokeFunction } from "@/lib/functions";

export interface CourseCardData {
  id: string;
  name: string;
  meta: string;
  importing: boolean;
  modeLabel: string;
  readyCount: number;
  totalCount: number;
}

export default function CourseCard({ course }: { course: CourseCardData }) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) closeMenu();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenu();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function closeMenu() {
    setMenuOpen(false);
    setConfirming(false);
    setError(null);
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      await invokeFunction("polya-import", {
        action: "delete_course",
        course_id: course.id,
      });
      router.refresh();
    } catch {
      setDeleting(false);
      setError("Couldn't remove that course. Try again.");
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <Link
        href={`/app/courses/${course.id}`}
        aria-hidden={deleting}
        className={`flex flex-col gap-3.5 rounded-[10px] border border-line bg-surface p-5 text-ink shadow-card hover:border-ink3 hover:text-ink ${
          deleting ? "pointer-events-none opacity-50" : ""
        }`}
      >
        <div className="flex flex-col gap-[3px] pr-7">
          <span className="font-mono text-[10.5px] text-ink3">{course.meta}</span>
          <h2 className="text-[15.5px] tracking-[-0.015em]">{course.name}</h2>
        </div>
        <div className="mt-auto flex items-center gap-2.5 border-t border-line-soft pt-3">
          {course.importing ? (
            <span className="rounded bg-amber-soft px-[7px] py-0.5 text-[10px] font-[650] uppercase tracking-[0.07em] text-amber">
              Importing
            </span>
          ) : (
            <span className="rounded bg-accent-soft px-[7px] py-0.5 text-[10px] font-[650] uppercase tracking-[0.07em] text-accent-ink">
              {course.modeLabel}
            </span>
          )}
          <span className="text-[12px] text-ink3">
            {course.importing
              ? `${course.readyCount} of ${course.totalCount} ready`
              : `${course.readyCount} source${course.readyCount === 1 ? "" : "s"} ready`}
          </span>
          <span className="ml-auto text-[12px] font-semibold text-accent-ink">
            Study →
          </span>
        </div>
      </Link>

      <button
        type="button"
        aria-label="Course options"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={deleting}
        onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-ink3 hover:bg-line-soft hover:text-ink disabled:opacity-50"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="3" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="8" cy="13" r="1.4" />
        </svg>
      </button>

      {menuOpen ? (
        <div
          role="menu"
          className="absolute right-2 top-9 z-10 w-52 rounded-[9px] border border-line bg-surface p-1.5 shadow-card"
        >
          {confirming ? (
            <div className="flex flex-col gap-2 p-1.5">
              <p className="text-[12px] leading-[1.4] text-ink2">
                Remove <span className="font-semibold text-ink">{course.name}</span>{" "}
                and everything imported for it?
              </p>
              {error ? (
                <p className="text-[11.5px] text-danger">{error}</p>
              ) : null}
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={deleting}
                  onClick={handleDelete}
                  className="flex-1 cursor-pointer rounded-md bg-danger px-2 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
                >
                  {deleting ? "Removing…" : "Delete"}
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => {
                    setConfirming(false);
                    setError(null);
                  }}
                  className="cursor-pointer rounded-md border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink2 hover:bg-line-soft"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => setConfirming(true)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] font-medium text-danger hover:bg-line-soft"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M2.5 4h11M6 4V2.5h4V4M12.5 4l-.6 9a1 1 0 0 1-1 .9H5.1a1 1 0 0 1-1-.9L3.5 4M6.5 7v4M9.5 7v4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Delete course
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
