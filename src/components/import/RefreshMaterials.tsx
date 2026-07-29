"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { FunctionError, invokeFunction } from "@/lib/functions";
import type { ImportProgress } from "@/lib/types";
import { importIsComplete } from "@/lib/types";

interface Props {
  courseId: string;
  canvasCourseId: string;
}

// "Check for updates" — re-runs enumeration with force so changed Canvas
// content is re-fetched, then pumps processing to completion.
export default function RefreshMaterials({ courseId, canvasCourseId }: Props) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "checking" | "done">("idle");
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRefresh = useCallback(async () => {
    setState("checking");
    setError(null);
    setSummary(null);
    try {
      const started = await invokeFunction<{
        course_id: string;
        queued: number;
        refreshed: number;
      }>("polya-import", {
        action: "start",
        canvas_course_id: canvasCourseId,
        force: true,
      });

      let safety = 4000;
      while (safety-- > 0) {
        const result = await invokeFunction<{
          done: boolean;
          progress: ImportProgress;
          retry_after_ms?: number;
        }>("polya-import", { action: "process", course_id: courseId });
        if (result.done || importIsComplete(result.progress)) break;
        if (result.retry_after_ms) {
          await new Promise((resolve) => setTimeout(resolve, result.retry_after_ms));
        }
      }

      const changed = started.queued + started.refreshed;
      setSummary(
        changed === 0
          ? "Everything is already up to date."
          : `Brought in ${changed} update${changed === 1 ? "" : "s"} from Canvas.`,
      );
      setState("done");
      router.refresh();
    } catch (err) {
      if (err instanceof FunctionError && err.code === "no_connection") {
        setError("Connect your Canvas first to check for updates.");
      } else {
        setError(err instanceof Error ? err.message : "Couldn't check for updates.");
      }
      setState("idle");
    }
  }, [canvasCourseId, courseId, router]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleRefresh}
          disabled={state === "checking"}
          className="self-start rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:border-ink3 hover:bg-rail disabled:cursor-default disabled:opacity-60"
        >
          {state === "checking" ? "Checking Canvas…" : "Check for updates"}
        </button>
        {summary ? <span className="text-[12px] text-ink3">{summary}</span> : null}
      </div>
      {error ? (
        <p className="m-0 rounded-lg bg-amber-soft px-3 py-2 text-[12px] text-amber">{error}</p>
      ) : null}
    </div>
  );
}
