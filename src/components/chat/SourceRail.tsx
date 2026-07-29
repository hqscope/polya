"use client";

import { sourceLocation } from "@/lib/citations";
import type { TutorSource as Source } from "@/lib/sse";

interface Props {
  sources: Source[];
  activeCitation: number | null;
  onSelect: (n: number) => void;
}

// The evidence rail: the numbered sources behind the current answer. A click
// highlights the source and opens it in the viewer at the cited spot.
export default function SourceRail({ sources, activeCitation, onSelect }: Props) {
  if (sources.length === 0) {
    return (
      <p className="m-0 px-[3px] pt-1 text-[11px] leading-[1.6] text-ink3">
        Sources for each answer show up here — every claim Polya makes points
        back to where it came from in your course.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-[7px]">
      {sources.map((source) => (
        <button
          key={source.n}
          type="button"
          onClick={() => onSelect(source.n)}
          className={`flex w-full animate-fade-up cursor-pointer flex-col gap-[5px] rounded-lg border px-[11px] py-2.5 text-left ${
            activeCitation === source.n
              ? "border-accent bg-accent-soft"
              : "border-line bg-surface hover:border-accent"
          }`}
        >
          <span className="flex min-w-0 items-center gap-[7px]">
            <span className="inline-flex h-[15px] min-w-[15px] shrink-0 items-center justify-center rounded bg-accent-soft px-1 text-[10px] font-bold text-accent-ink">
              {source.n}
            </span>
            <span className="truncate text-[12.5px] font-semibold">
              {source.title}
            </span>
          </span>
          <span className="font-mono text-[10.5px] text-ink3">
            {sourceLocation(source)}
          </span>
          <span className="line-clamp-2 text-[11.5px] leading-[1.55] text-ink2">
            {source.snippet}
          </span>
        </button>
      ))}
      <p className="m-0 mt-1.5 px-[3px] text-[11px] leading-[1.6] text-ink3">
        Every claim points back to where it came from in your course. Click a
        citation to see it.
      </p>
    </div>
  );
}
