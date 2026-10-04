"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { invokeFunction } from "@/lib/functions";
import { IMPORT_STARTED_EVENT } from "@/lib/import-events";
import { importPending, type StatusAllResponse } from "@/lib/types";
import {
  AI_BUSY_POLYA_IMPORT_DETAIL,
  AI_BUSY_POLYA_IMPORT_QUEUE,
  AI_BUSY_POLYA_IMPORT_STATUS,
} from "@/lib/ai-busy";

// Bottom-of-sidebar indicator for imports running in the background. Polls while
// any course is importing, shows per-course progress, and revives the worker if
// it sees importing work with no live worker (e.g. after a deploy). Renders
// nothing when there's no active import.
//
// With nothing importing it stops polling. It checks again when an import
// starts on this page (`announceImportStarted`), on every page change, and when
// the window regains focus (an import started from the extension or another tab).
export default function ImportsIndicator() {
  const pathname = usePathname();
  const router = useRouter();
  const [data, setData] = useState<StatusAllResponse | null>(null);
  const [wake, setWake] = useState(0);
  // Courses seen importing on the last check. When one drops off the list its
  // import finished, so server-rendered pages (Materials, the course list)
  // are refreshed to show the new material.
  const importingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const check = () => setWake((n) => n + 1);
    window.addEventListener(IMPORT_STARTED_EVENT, check);
    window.addEventListener("focus", check);
    return () => {
      window.removeEventListener(IMPORT_STARTED_EVENT, check);
      window.removeEventListener("focus", check);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      try {
        const res = await invokeFunction<StatusAllResponse>("polya-import", {
          action: "status_all",
        });
        if (cancelled) return;
        setData(res);
        const now = new Set(res.courses.map((course) => course.course_id));
        const finished = [...importingRef.current].some((id) => !now.has(id));
        importingRef.current = now;
        if (finished) router.refresh();
        // Revive a stalled import: work remains but no worker is alive.
        if (res.courses.length > 0 && !res.worker_alive) {
          try {
            await invokeFunction("polya-import", { action: "kick" });
          } catch {
            /* retried on the next tick */
          }
        }
        // Nothing importing: stop until something wakes the indicator.
        if (res.courses.length > 0) timer = setTimeout(tick, 4000);
      } catch {
        if (!cancelled) timer = setTimeout(tick, 20000);
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pathname, wake, router]);

  const courses = data?.courses ?? [];
  if (courses.length === 0) return null;

  // No worker holding the lease while courses are still importing: today the
  // only way the pump lets go of it here is a deep backoff park (the R-5 AI
  // budget, or a per-user daily import cap — both "e.g. a daily quota" in
  // `runPump`'s own comment) or a crashed invocation whose lease is expiring.
  // Either way "paused, resumes on its own" is the honest thing to show; the
  // existing revive-on-stall kick (below) still covers the crash case.
  const isPaused = data?.worker_alive === false;

  let ready = 0;
  let total = 0;
  for (const course of courses) {
    ready += course.progress.ready;
    total += course.progress.total;
  }

  return (
    <div className="rounded-[9px] border border-line bg-rail px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={
            isPaused
              ? "h-[13px] w-[13px] shrink-0 rounded-full border-[2px] border-accent-soft"
              : "h-[13px] w-[13px] shrink-0 animate-spin rounded-full border-[2px] border-accent-soft border-t-accent"
          }
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-semibold text-ink">
            {isPaused
              ? AI_BUSY_POLYA_IMPORT_STATUS
              : `Importing ${courses.length} course${courses.length === 1 ? "" : "s"}`}
          </span>
          <span className="block text-[11px] text-ink3">
            {isPaused ? AI_BUSY_POLYA_IMPORT_DETAIL : `${ready} of ${total} ready`}
          </span>
          {isPaused && courses.length > 1 ? (
            <span className="mt-1 block text-[10.5px] text-ink3">{AI_BUSY_POLYA_IMPORT_QUEUE}</span>
          ) : null}
        </span>
      </div>

      <ul className="mt-2 flex max-h-[168px] flex-col gap-2 overflow-y-auto border-t border-line-soft pt-2">
        {courses.map((course) => {
          const p = course.progress;
          const pending = importPending(p);
          const pct = p.total > 0 ? Math.round(((p.total - pending) / p.total) * 100) : 0;
          return (
            <li key={course.course_id} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[11.5px] font-medium text-ink2">
                  {course.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-ink3">
                  {p.ready}/{p.total}
                </span>
              </div>
              <div className="h-[3px] overflow-hidden rounded-full bg-line-soft">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
