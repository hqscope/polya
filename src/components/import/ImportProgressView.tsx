"use client";

import { sourceStatusClass, sourceStatusLabel } from "@/lib/sources";
import type { ImportProgress, SourceRow } from "@/lib/types";

interface Props {
  progress: ImportProgress;
  sources: SourceRow[];
  done: boolean;
  onOpenCourse: () => void;
  onRetry?: () => void;
  retrying?: boolean;
}

export default function ImportProgressView({
  progress,
  sources,
  done,
  onOpenCourse,
  onRetry,
  retrying,
}: Props) {
  const finished = progress.ready + progress.failed + progress.skipped + progress.needs_ocr;
  const pct = progress.total > 0 ? Math.round((finished / progress.total) * 100) : 0;
  const unreadable = progress.failed + progress.needs_ocr;

  const subParts = [`${progress.ready} of ${progress.total} materials ready`];
  if (done && progress.needs_ocr > 0) {
    subParts.push(
      `${progress.needs_ocr} scanned page${progress.needs_ocr === 1 ? "" : "s"} skipped`,
    );
  }
  if (done && progress.failed > 0) {
    subParts.push(`${progress.failed} couldn't be read`);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        {done ? (
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent text-[11px] font-bold text-on-accent">
            ✓
          </span>
        ) : (
          <span className="h-[18px] w-[18px] shrink-0 animate-spin rounded-full border-[2.5px] border-accent-soft border-t-accent" />
        )}
        <div className="flex flex-col gap-px">
          <h2 className="text-[15.5px] tracking-[-0.015em]">
            {done ? "Your course is ready" : "Bringing in your course…"}
          </h2>
          <span className="text-[12px] text-ink2">{subParts.join(" · ")}</span>
        </div>
      </div>

      <div className="h-[5px] overflow-hidden rounded-full bg-line-soft">
        <div
          className="h-full rounded-full bg-accent transition-all duration-400"
          style={{ width: `${pct}%` }}
        />
      </div>

      {sources.length > 0 ? (
        <div className="flex max-h-[248px] flex-col overflow-y-auto rounded-[9px] border border-line-soft bg-rail px-3.5 py-1.5">
          {sources.map((source) => (
            <div
              key={source.id}
              className="flex items-center justify-between gap-3 border-b border-line-soft py-[7px] last:border-b-0"
            >
              <span className="truncate text-[12.5px]">{source.title}</span>
              <span
                className={`shrink-0 text-[11px] font-semibold ${sourceStatusClass(source.status)}`}
              >
                {sourceStatusLabel(source.status)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {done ? (
        <div className="flex flex-col gap-2.5">
          <button
            type="button"
            onClick={onOpenCourse}
            className="button-primary h-9 w-full cursor-pointer text-[13px]"
          >
            Start studying →
          </button>
          {onRetry && unreadable > 0 ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="button-secondary h-9 w-full cursor-pointer text-[13px] disabled:opacity-60"
            >
              {retrying
                ? "Trying again…"
                : `Try ${unreadable} skipped item${unreadable === 1 ? "" : "s"} again`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
