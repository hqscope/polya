"use client";

import Link from "next/link";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import SourceRail from "@/components/chat/SourceRail";
import SourcePanel from "@/components/viewer/SourcePanel";
import { MasteryTracker, MistakeCard, StudyPlanView, type TrackerTopic } from "@/components/coach/blocks";
import type { StudyPlan } from "@/lib/coach";
import type { TutorSource } from "@/lib/sse";
import type { MockRow, StudyErrorRow } from "@/lib/study";

export type RailTab = "plan" | "progress" | "mistakes" | "sources";
export type RailOverride = { kind: "source"; source: TutorSource } | { kind: "details" } | null;

const TABS: { id: RailTab; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "progress", label: "Progress" },
  { id: "mistakes", label: "Mistakes" },
  { id: "sources", label: "Sources" },
];

interface Props {
  tab: RailTab;
  onTab: (tab: RailTab) => void;
  override: RailOverride;
  onCloseOverride: () => void;
  /** The exam's details panel (edit, files, topics, uploads). */
  details: ReactNode;
  courseId: string;
  examId: string;
  today: string;
  plan: StudyPlan | null;
  onTogglePlan: (itemId: string, done: boolean) => void;
  onAsk: (text: string) => void;
  busy: boolean;
  tracker: readonly TrackerTopic[];
  onDrill: (topicId: string) => void;
  mocks: readonly MockRow[];
  errors: readonly (StudyErrorRow & { fixed: boolean })[];
  topicTitle: (id: string) => string | null;
  onClearError: (id: string) => void;
  sources: readonly TutorSource[];
  activeCitation: number | null;
  onSelectSource: (n: number) => void;
  /** Phones: the sheet's close button. */
  onClose?: () => void;
}

const MOCK_STATUS: Record<MockRow["status"], string> = {
  building: "Being written",
  ready: "Ready to start",
  in_progress: "In progress",
  submitted: "Finished",
};

export default function CoachRail(props: Props) {
  const { tab, onTab, override } = props;
  const tabRefs = useRef<Record<RailTab, HTMLButtonElement | null>>({ plan: null, progress: null, mistakes: null, sources: null });
  const [showFixed, setShowFixed] = useState(false);

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
      ? TABS.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    const id = TABS[next]!.id;
    onTab(id);
    tabRefs.current[id]?.focus();
  }

  if (override?.kind === "source") {
    return <SourcePanel source={override.source} onBack={props.onCloseOverride} backLabel="← Back" />;
  }
  if (override?.kind === "details") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-10 shrink-0 items-center border-b border-line-soft px-3.5">
          <button type="button" onClick={props.onCloseOverride} className="cursor-pointer py-2.5 pr-3 text-[12px] font-medium text-ink3 hover:text-ink">
            ← Back
          </button>
          <span className="text-[12px] font-semibold">Exam details</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pt-3 pb-6">{props.details}</div>
      </div>
    );
  }

  const open = props.errors.filter((e) => !e.fixed);
  const fixed = props.errors.filter((e) => e.fixed);
  const ready = props.tracker.filter((t) => t.stage === "exam_ready").length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Your exam" className="flex h-10 shrink-0 items-stretch gap-0.5 border-b border-line-soft px-2">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            id={`coach-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`coach-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => onTab(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
            className={`cursor-pointer border-b-2 px-2.5 text-[12px] font-semibold ${
              tab === t.id ? "border-accent text-ink" : "border-transparent text-ink3 hover:text-ink"
            }`}
          >
            {t.label}
            {t.id === "mistakes" && open.length > 0 ? <span className="ml-1 font-mono text-[10.5px] text-amber">{open.length}</span> : null}
          </button>
        ))}
        {props.onClose ? (
          <button type="button" onClick={props.onClose} className="ml-auto cursor-pointer px-2 text-[12px] font-medium text-ink3 hover:text-ink">
            Close
          </button>
        ) : null}
      </div>

      <div
        role="tabpanel"
        id={`coach-panel-${tab}`}
        aria-labelledby={`coach-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto px-3.5 pt-3 pb-6"
      >
        {tab === "plan" ? (
          props.plan ? (
            <StudyPlanView plan={props.plan} today={props.today} live onToggle={props.onTogglePlan} />
          ) : (
            <div className="flex flex-col gap-2.5">
              <p className="m-0 text-[12.5px] leading-[1.6] text-ink2">No plan yet.</p>
              <button
                type="button"
                disabled={props.busy}
                onClick={() => props.onAsk("Make me a plan for the days I have left.")}
                className="button-secondary h-8 cursor-pointer self-start text-[12px] disabled:opacity-50"
              >
                Make me a plan for the days I have left
              </button>
            </div>
          )
        ) : null}

        {tab === "progress" ? (
          <div className="flex flex-col gap-4">
            {props.tracker.length > 0 ? (
              <p className="m-0 text-[12.5px] text-ink2">
                {ready} of {props.tracker.length} topic{props.tracker.length === 1 ? "" : "s"} exam-ready
              </p>
            ) : null}
            <MasteryTracker topics={props.tracker} onDrill={props.onDrill} />
            {props.mocks.length > 0 ? (
              <section className="flex flex-col gap-1.5">
                <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">Mock exams</span>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {props.mocks.map((mock) => (
                    <li key={mock.id}>
                      <Link
                        href={`/app/courses/${props.courseId}/study/${props.examId}/mock/${mock.id}`}
                        className="flex items-baseline gap-2 rounded-md px-1 py-1 text-[12.5px] hover:bg-line-soft"
                      >
                        <span className="min-w-0 flex-1 truncate font-medium">{mock.title}</span>
                        <span className="shrink-0 text-[11px] text-ink3">
                          {mock.status === "submitted" && mock.score !== null ? `${Math.round(mock.score * 100)}%` : MOCK_STATUS[mock.status]}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}

        {tab === "mistakes" ? (
          <div className="flex flex-col gap-2">
            {open.length === 0 && fixed.length === 0 ? (
              <p className="m-0 text-[12.5px] leading-[1.6] text-ink2">
                Nothing here yet. When you miss a question, Polya notes what went wrong so you can fix it before the exam.
              </p>
            ) : null}
            {open.map((error) => (
              <MistakeCard
                key={error.id}
                error={error}
                topicTitle={error.topic_id ? props.topicTitle(error.topic_id) : null}
                onClear={() => props.onClearError(error.id)}
              />
            ))}
            {fixed.length > 0 ? (
              <button
                type="button"
                onClick={() => setShowFixed((on) => !on)}
                className="cursor-pointer self-start pt-1 text-[11.5px] text-ink3 underline hover:text-ink"
              >
                {showFixed ? "Hide fixed" : `Fixed since (${fixed.length})`}
              </button>
            ) : null}
            {showFixed
              ? fixed.map((error) => (
                <MistakeCard
                  key={error.id}
                  error={error}
                  topicTitle={error.topic_id ? props.topicTitle(error.topic_id) : null}
                  fixed
                  onClear={() => props.onClearError(error.id)}
                />
              ))
              : null}
          </div>
        ) : null}

        {tab === "sources" ? (
          props.sources.length > 0 ? (
            <SourceRail sources={[...props.sources]} activeCitation={props.activeCitation} onSelect={props.onSelectSource} />
          ) : (
            <p className="m-0 text-[12.5px] text-ink3">The course passages behind Polya&apos;s latest answer show up here.</p>
          )
        ) : null}
      </div>
    </div>
  );
}
