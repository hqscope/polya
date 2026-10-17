"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { buildMock, type BuildState } from "@/lib/mock-client";
import { FunctionError } from "@/lib/functions";
import { AI_BUSY_POLYA_STUDY } from "@/lib/ai-busy";
import { userMessage } from "@/lib/user-message";
import {
  STAGE_CLASS,
  STAGE_HINT,
  STAGE_LABEL,
  STAGE_STEP,
  type MasteryStage,
  type MockRow,
  type StudyErrorRow,
} from "@/lib/study";
import type { StudyPlan } from "@/lib/coach";
import type { Inventory } from "../../../supabase/functions/_shared/study-inventory.ts";

// ---------------------------------------------------------------------------
// Stage badge and the four-step tracker
// ---------------------------------------------------------------------------
export function StageBadge({ stage }: { stage: MasteryStage }) {
  return (
    <span
      title={STAGE_HINT[stage]}
      className={`shrink-0 rounded px-2 py-[3px] text-[10px] font-[650] uppercase tracking-[0.07em] ${STAGE_CLASS[stage]}`}
    >
      {STAGE_LABEL[stage]}
    </span>
  );
}

function Ladder({ stage }: { stage: MasteryStage }) {
  const step = STAGE_STEP[stage];
  const slipped = stage === "needs_review";
  return (
    <span className="flex items-center gap-[3px]" aria-hidden>
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={`h-1.5 w-5 rounded-full ${
            n <= step ? (slipped && n === 3 ? "bg-amber" : "bg-accent") : "bg-line"
          }`}
        />
      ))}
    </span>
  );
}

export interface TrackerTopic {
  id: string;
  title: string;
  stage: MasteryStage;
  accuracy: number | null;
  attempts: number;
}

export function MasteryTracker({
  topics,
  onDrill,
}: {
  topics: readonly TrackerTopic[];
  onDrill?: (topicId: string) => void;
}) {
  if (topics.length === 0) {
    return <p className="m-0 text-[12.5px] text-ink3">No topics yet. Polya suggests them when you open the coach.</p>;
  }
  return (
    <ol className="m-0 flex list-none flex-col gap-0 p-0">
      {topics.map((topic) => (
        <li key={topic.id} className="flex flex-col gap-1.5 border-b border-line-soft py-2.5 last:border-b-0">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[13px] font-semibold leading-snug">{topic.title}</span>
            <StageBadge stage={topic.stage} />
          </div>
          <div className="flex items-center gap-2.5">
            <Ladder stage={topic.stage} />
            <span className="min-w-0 flex-1 truncate text-[11px] text-ink3">
              {topic.attempts > 0
                ? `${Math.round((topic.accuracy ?? 0) * 100)}% recently · ${topic.attempts} answered`
                : "No questions yet"}
            </span>
            {onDrill ? (
              <button
                type="button"
                onClick={() => onDrill(topic.id)}
                className="shrink-0 cursor-pointer text-[11.5px] font-semibold text-accent-ink hover:underline"
              >
                Drill
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function StageLine({ title, stage, note }: { title: string; stage: MasteryStage; note: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-rail px-3 py-2 text-[12.5px]">
      <span className="text-ink2">Progress:</span>
      <span className="font-semibold">{title}</span>
      <span aria-hidden className="text-ink3">→</span>
      <StageBadge stage={stage} />
      {note ? <span className="w-full text-[12px] text-ink3 sm:w-auto">{note}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The course inventory
// ---------------------------------------------------------------------------
export function InventoryBlock({
  inventory,
  onOpenSource,
  onAddMaterials,
}: {
  inventory: Inventory;
  onOpenSource: (sourceId: string, title: string) => void;
  onAddMaterials: () => void;
}) {
  return (
    <section aria-label="Your course materials" className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface px-4 py-3.5 shadow-card">
      <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">Your course materials</span>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {inventory.tiles.map((tile) => (
          <div
            key={tile.kind}
            className={`flex flex-col gap-0.5 rounded-lg px-3 py-2.5 ${tile.kind === "unreadable" ? "bg-amber-soft" : "bg-rail"}`}
          >
            <span className={`text-[20px] font-semibold tabular-nums ${tile.kind === "unreadable" ? "text-amber" : ""}`}>
              {tile.value}
            </span>
            <span className="text-[11.5px] leading-tight text-ink2">{tile.label}</span>
          </div>
        ))}
      </div>
      {inventory.in_progress > 0 ? (
        <p className="m-0 text-[12px] text-ink3">{inventory.in_progress} more are still being read.</p>
      ) : null}

      {inventory.exams_without_solutions.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg bg-amber-soft px-3 py-2.5">
          <p className="m-0 text-[12.5px] leading-[1.6] text-ink">
            No answer key found for{" "}
            {inventory.exams_without_solutions.map((exam, i) => (
              <span key={exam.source_id}>
                {i > 0 ? ", " : ""}
                <span className="font-semibold">{exam.title}</span>
              </span>
            ))}
            . Add it and Polya can check your work against it.
          </p>
          <button type="button" onClick={onAddMaterials} className="button-secondary h-8 cursor-pointer self-start text-[12px]">
            Add materials
          </button>
        </div>
      ) : null}

      <div className="flex flex-col">
        {inventory.groups.map((group) => (
          <details key={group.kind} className="border-t border-line-soft py-1.5 first:border-t-0">
            <summary className="flex cursor-pointer items-center gap-2 py-1 text-[12.5px]">
              <span className="font-semibold">{group.label}</span>
              <span className="font-mono text-[11px] text-ink3">{group.count}</span>
            </summary>
            <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 pl-1">
              {group.items.map((item) => (
                <li key={item.source_id} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenSource(item.source_id, item.title)}
                    className="min-w-0 flex-1 cursor-pointer truncate text-left text-[12.5px] text-ink2 hover:text-ink hover:underline"
                  >
                    {item.title}
                  </button>
                  {item.has_solution === false ? (
                    <span className="shrink-0 rounded bg-amber-soft px-1.5 py-[1px] text-[10px] font-semibold text-amber">
                      No answer key
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>

      {inventory.unreadable.length > 0 ? (
        <p className="m-0 text-[12px] leading-[1.6] text-ink3">
          Polya couldn&apos;t read{" "}
          {inventory.unreadable.map((u, i) => (
            <span key={u.source_id}>
              {i > 0 ? "; " : ""}
              {u.title} ({u.reason})
            </span>
          ))}
          .
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The study plan
// ---------------------------------------------------------------------------
function dayLabel(date: string, today: string): string {
  if (date === today) return "Today";
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function StudyPlanView({
  plan,
  today,
  live,
  compact = false,
  onToggle,
}: {
  plan: StudyPlan;
  today: string;
  /** Only the newest plan can be ticked off; older ones are snapshots. */
  live: boolean;
  compact?: boolean;
  onToggle?: (itemId: string, done: boolean) => void;
}) {
  const [showPast, setShowPast] = useState(false);
  const past = plan.days.filter((d) => d.date < today);
  const upcoming = plan.days.filter((d) => d.date >= today);
  const shown = compact ? upcoming.slice(0, 3) : showPast ? plan.days : upcoming;
  return (
    <div className="flex flex-col gap-2.5">
      {plan.note ? <p className="m-0 text-[12.5px] leading-[1.6] text-ink2">{plan.note}</p> : null}
      {!compact && past.length > 0 ? (
        <button
          type="button"
          onClick={() => setShowPast((on) => !on)}
          className="cursor-pointer self-start text-[11.5px] text-ink3 underline hover:text-ink"
        >
          {showPast ? "Hide earlier days" : `Show ${past.length} earlier day${past.length === 1 ? "" : "s"}`}
        </button>
      ) : null}
      {shown.length === 0 ? <p className="m-0 text-[12.5px] text-ink3">Every day in this plan has passed.</p> : null}
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {shown.map((day) => (
          <li
            key={day.date}
            className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 ${
              day.date === today ? "border-accent bg-accent-soft/50" : "border-line-soft bg-surface"
            }`}
          >
            <div className="flex items-baseline gap-2">
              <span className="text-[12px] font-bold">{dayLabel(day.date, today)}</span>
              <span className="min-w-0 truncate text-[12px] text-ink2">{day.focus}</span>
            </div>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {day.items.map((item) => (
                <li key={item.id}>
                  <label className={`flex items-start gap-2 text-[12.5px] leading-[1.5] ${live ? "cursor-pointer" : ""}`}>
                    <input
                      type="checkbox"
                      checked={item.done}
                      disabled={!live || !onToggle}
                      onChange={(e) => onToggle?.(item.id, e.target.checked)}
                      className="mt-[3px] accent-[var(--accent)]"
                    />
                    <span className={item.done ? "text-ink3 line-through" : ""}>{item.text}</span>
                  </label>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {compact && upcoming.length > shown.length ? (
        <span className="text-[11.5px] text-ink3">+{upcoming.length - shown.length} more days in your plan</span>
      ) : null}
      {!live ? <span className="text-[11.5px] text-ink3">This plan has changed since. The current one is under Plan.</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A logged mistake
// ---------------------------------------------------------------------------
export function MistakeCard({
  error,
  topicTitle,
  fixed,
  heading,
  onClear,
}: {
  error: Pick<StudyErrorRow, "what" | "why" | "fix">;
  topicTitle: string | null;
  fixed?: boolean;
  /** "Added to your mistakes" in the conversation; nothing in the list. */
  heading?: string;
  onClear?: () => void;
}) {
  return (
    <div className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 ${fixed ? "border-line-soft bg-rail" : "border-amber/40 bg-surface"}`}>
      {heading ? <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-amber">{heading}</span> : null}
      <div className="flex items-start gap-2">
        <span className={`min-w-0 flex-1 text-[13px] font-semibold leading-snug ${fixed ? "text-ink2" : ""}`}>{error.what}</span>
        {fixed ? <span className="shrink-0 rounded bg-accent-soft px-1.5 py-[1px] text-[10px] font-semibold text-accent-ink">Fixed</span> : null}
      </div>
      {topicTitle ? <span className="text-[11px] text-ink3">{topicTitle}</span> : null}
      {error.why ? (
        <p className="m-0 text-[12.5px] leading-[1.55] text-ink2">
          <span className="font-semibold text-ink">Why it happened:</span> {error.why}
        </p>
      ) : null}
      {error.fix ? (
        <p className="m-0 text-[12.5px] leading-[1.55] text-ink2">
          <span className="font-semibold text-ink">Next time:</span> {error.fix}
        </p>
      ) : null}
      {onClear ? (
        <button type="button" onClick={onClear} className="cursor-pointer self-start text-[11.5px] text-ink3 underline hover:text-ink">
          I&apos;ve got this now
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A mock exam card
// ---------------------------------------------------------------------------
function minutesLeft(dueAt: string | null, now: number): number | null {
  if (!dueAt) return null;
  return Math.max(0, Math.ceil((Date.parse(dueAt) - now) / 60_000));
}

export function MockCard({
  mock,
  courseId,
  examId,
  questionCount,
  onBuilt,
}: {
  mock: Pick<MockRow, "id" | "title" | "minutes" | "status" | "due_at" | "score">;
  courseId: string;
  examId: string;
  questionCount: number;
  onBuilt: (mockId: string, state: BuildState) => void;
}) {
  const [progress, setProgress] = useState<BuildState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const href = `/app/courses/${courseId}/study/${examId}/mock/${mock.id}`;

  useEffect(() => {
    if (mock.status !== "building") return;
    let live = true;
    buildMock(mock.id, (state) => {
      if (live) setProgress(state);
    })
      .then((state) => {
        if (live) onBuilt(mock.id, state);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(
          err instanceof FunctionError && err.code === "busy"
            ? AI_BUSY_POLYA_STUDY
            : err instanceof FunctionError && err.code === "rate_limited"
            ? err.message
            : userMessage(err),
        );
      });
    return () => {
      live = false;
    };
  }, [mock.id, mock.status, onBuilt]);

  const left = minutesLeft(mock.due_at, now);
  return (
    <section aria-label={mock.title} className="flex flex-col gap-2 rounded-[10px] border border-line bg-surface px-4 py-3.5 shadow-card">
      <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">Mock exam</span>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[15px] font-semibold">{mock.title}</span>
        <span className="text-[12px] text-ink3">
          {mock.minutes} min · {progress?.total ?? questionCount} questions
        </span>
      </div>
      {mock.status === "building" ? (
        error ? (
          <p role="status" className="m-0 text-[12.5px] text-ink2">{error}</p>
        ) : (
          <p role="status" className="m-0 flex items-center gap-2 text-[12.5px] text-ink2">
            <span className="h-1.5 w-1.5 animate-dot-pulse rounded-full bg-accent" aria-hidden />
            Writing your questions and checking every answer
            {progress ? ` · ${progress.built} of ${progress.total}` : ""}. This takes a few minutes.
          </p>
        )
      ) : mock.status === "ready" ? (
        <Link href={href} className="button-primary h-9 self-start">
          Start when you&apos;re ready
        </Link>
      ) : mock.status === "in_progress" ? (
        <Link href={href} className="button-primary h-9 self-start">
          Resume{left !== null ? ` · ${left} min left` : ""}
        </Link>
      ) : (
        <Link href={href} className="text-[12.5px] font-semibold text-accent-ink hover:underline">
          Finished{mock.score !== null ? ` · ${Math.round(mock.score * 100)}%` : ""} · See your report →
        </Link>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Quick replies
// ---------------------------------------------------------------------------
export function QuickReplies({
  replies,
  disabled,
  onPick,
}: {
  replies: readonly string[];
  disabled: boolean;
  onPick: (reply: string) => void;
}) {
  if (replies.length === 0) return null;
  return (
    <div role="group" aria-label="Suggested replies" className="flex snap-x gap-1.5 overflow-x-auto pb-0.5">
      {replies.map((reply) => (
        <button
          key={reply}
          type="button"
          disabled={disabled}
          onClick={() => onPick(reply)}
          className="h-[28px] shrink-0 snap-start cursor-pointer rounded-full border border-line bg-surface px-3 text-[12px] font-medium text-ink2 hover:border-accent hover:bg-accent-soft hover:text-accent-ink disabled:cursor-default disabled:opacity-40"
        >
          {reply}
        </button>
      ))}
    </div>
  );
}
