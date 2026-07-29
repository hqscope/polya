"use client";

import { useEffect, useState } from "react";

import { invokeFunction } from "@/lib/functions";
import { importPending, type StatusAllResponse } from "@/lib/types";

// Bottom-of-sidebar indicator for imports running in the background. Polls while
// any course is importing, shows per-course progress, and revives the worker if
// it sees importing work with no live worker (e.g. after a deploy). Renders
// nothing when there's no active import.
export default function ImportsIndicator() {
  const [data, setData] = useState<StatusAllResponse | null>(null);

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
        // Revive a stalled import: work remains but no worker is alive.
        if (res.courses.length > 0 && !res.worker_alive) {
          try {
            await invokeFunction("polya-import", { action: "kick" });
          } catch {
            /* retried on the next tick */
          }
        }
        timer = setTimeout(tick, res.courses.length > 0 ? 4000 : 20000);
      } catch {
        if (!cancelled) timer = setTimeout(tick, 20000);
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const courses = data?.courses ?? [];
  if (courses.length === 0) return null;

  let ready = 0;
  let total = 0;
  for (const course of courses) {
    ready += course.progress.ready;
    total += course.progress.total;
  }

  return (
    <div className="rounded-[9px] border border-line bg-rail px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="h-[13px] w-[13px] shrink-0 animate-spin rounded-full border-[2px] border-accent-soft border-t-accent" />
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-semibold text-ink">
            Importing {courses.length} course{courses.length === 1 ? "" : "s"}
          </span>
          <span className="block text-[11px] text-ink3">{ready} of {total} ready</span>
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
