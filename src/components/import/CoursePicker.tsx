"use client";

import { useState } from "react";

import type { CanvasCourseOption } from "@/lib/types";

interface Props {
  courses: CanvasCourseOption[];
  onImport: (canvasCourseIds: string[]) => void;
  busy?: boolean;
  // canvas_course_id -> import_status for courses already in the library.
  importedStatus?: Map<string, string>;
}

function courseMeta(course: CanvasCourseOption): string {
  return [course.code, course.term_name].filter(Boolean).join(" · ") || "Course";
}

export default function CoursePicker({ courses, onImport, busy, importedStatus }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (courses.length === 0) {
    return (
      <div className="rounded-lg border border-line-soft bg-rail px-3.5 py-3 text-[12.5px] leading-[1.65] text-ink2">
        We couldn&apos;t find any active courses on this Canvas account. If your
        term hasn&apos;t started yet, check back once your courses are published.
      </div>
    );
  }

  const status = (id: string) => importedStatus?.get(id);
  const selectableIds = courses
    .map((c) => c.canvas_course_id)
    .filter((id) => status(id) === undefined);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  }

  const buttonLabel = busy
    ? "Starting…"
    : selected.size > 0
      ? `Bring in ${selected.size} course${selected.size === 1 ? "" : "s"} →`
      : selectableIds.length === 0
        ? "All your courses are already in"
        : "Select courses to bring in";

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-end gap-3">
        <div className="flex min-w-0 flex-col gap-[3px]">
          <h2 className="text-[15.5px] tracking-[-0.015em]">Pick your courses</h2>
          <p className="m-0 text-[12.5px] text-ink2">
            Bring in as many as you like — they import in the background while you
            study.
          </p>
        </div>
        {selectableIds.length > 0 ? (
          <button
            type="button"
            onClick={toggleAll}
            disabled={busy}
            className="ml-auto shrink-0 cursor-pointer text-[12px] font-semibold text-accent-ink hover:underline disabled:opacity-60"
          >
            {allSelected ? "Clear all" : "Select all"}
          </button>
        ) : null}
      </div>

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {courses.map((course) => {
          const id = course.canvas_course_id;
          const importState = status(id);

          if (importState !== undefined) {
            const importing = importState === "importing";
            return (
              <li key={id}>
                <div className="flex w-full items-center gap-3 rounded-[9px] border border-line-soft bg-rail px-4 py-[13px]">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[13.5px] font-semibold text-ink2 wrap-anywhere">{course.name}</span>
                    <span className="font-mono text-[10.5px] text-ink3 wrap-anywhere">{courseMeta(course)}</span>
                  </span>
                  <span
                    className={`ml-auto shrink-0 rounded px-[7px] py-0.5 text-[10px] font-[650] uppercase tracking-[0.06em] ${
                      importing ? "bg-amber-soft text-amber" : "bg-accent-soft text-accent-ink"
                    }`}
                  >
                    {importing ? "Importing…" : "✓ Imported"}
                  </span>
                </div>
              </li>
            );
          }

          const checked = selected.has(id);
          return (
            <li key={id}>
              <label
                className={`flex w-full cursor-pointer items-center gap-3 rounded-[9px] border px-4 py-[13px] text-left shadow-card ${
                  checked ? "border-accent bg-accent-soft/40" : "border-line bg-surface hover:border-ink3"
                } ${busy ? "opacity-60" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy}
                  onChange={() => toggle(id)}
                  className="h-[15px] w-[15px] shrink-0 cursor-pointer accent-accent"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13.5px] font-semibold wrap-anywhere">{course.name}</span>
                  <span className="font-mono text-[10.5px] text-ink3 wrap-anywhere">{courseMeta(course)}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        disabled={busy || selected.size === 0}
        onClick={() => onImport(Array.from(selected))}
        className="button-primary h-9 w-full cursor-pointer text-[13px] disabled:opacity-60"
      >
        {buttonLabel}
      </button>
    </div>
  );
}
