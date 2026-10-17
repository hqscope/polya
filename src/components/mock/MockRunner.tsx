"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import MathText from "@/components/MathText";
import MockReport from "@/components/mock/MockReport";
import PartField from "@/components/study/PartField";
import { AI_BUSY_POLYA_STUDY } from "@/lib/ai-busy";
import { FunctionError, invokeFunction } from "@/lib/functions";
import { buildMock, type BuildState } from "@/lib/mock-client";
import {
  answeredCount,
  emptyMockDraft,
  formatRemaining,
  isAnswered,
  mockDraftKey,
  parseMockDraft,
  remainingMs,
  unfinishedNotice,
  warningCrossed,
  type MockDraft,
  type MockQuestion,
  type MockReview,
} from "@/lib/mock-exam";
import { emptyDraft, responsesFromDrafts, type Draft, type MockRow } from "@/lib/study";
import { userMessage } from "@/lib/user-message";

interface Props {
  courseId: string;
  examId: string;
  examTitle: string;
  userId: string;
  mock: { id: string; title: string; minutes: number; status: MockRow["status"]; questionCount: number };
  /** Minutes since the clock started, for a mock already under way. */
  minutesIn: number;
  topics: { id: string; title: string }[];
  /** A mock handed in earlier: its report and questions. */
  review: MockReview | null;
}

type Phase =
  | { kind: "building" }
  | { kind: "intro"; count: number; short: boolean }
  | { kind: "resume" }
  | { kind: "running" }
  | { kind: "report" };

interface StartResult {
  mock: { id: string; title: string; minutes: number; status: string; started_at: string | null; due_at: string | null };
  questions: MockQuestion[];
  server_now: string;
}

const FIVE_MINUTES = 5 * 60_000;
const SUBMIT_BUSY =
  "Polya can't check your answers right now. Things are busier than usual, so try again in a little while. Your answers are saved on this device.";

function errorText(err: unknown, busy: string): string {
  if (err instanceof FunctionError) {
    if (err.code === "busy") return busy;
    if (["rate_limited", "conflict", "slow", "unavailable"].includes(err.code)) return err.message;
  }
  return userMessage(err);
}

function initialPhase(mock: Props["mock"]): Phase {
  switch (mock.status) {
    case "building":
      return { kind: "building" };
    case "ready":
      return { kind: "intro", count: mock.questionCount, short: false };
    case "in_progress":
      return { kind: "resume" };
    case "submitted":
      return { kind: "report" };
  }
}

// A timed mock exam: wait while its questions are written and checked, start
// the clock, answer with no help, hand it in (or let the clock do it), then
// read the report.
export default function MockRunner({ courseId, examId, examTitle, userId, mock, minutesIn, topics, review: initialReview }: Props) {
  const baseId = useId();
  const storageKey = mockDraftKey(userId, mock.id);
  const examHref = `/app/courses/${courseId}/study/${examId}`;

  const [phase, setPhase] = useState<Phase>(() => initialPhase(mock));
  const [progress, setProgress] = useState<BuildState | null>(null);
  const [buildTry, setBuildTry] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [questions, setQuestions] = useState<MockQuestion[]>([]);
  const [draft, setDraft] = useState<MockDraft>({ answers: {}, flagged: [], current: 0 });
  const [clock, setClock] = useState<{ dueAt: string; skew: number } | null>(null);
  const [now, setNow] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [handingIn, setHandingIn] = useState<"idle" | "manual" | "auto">("idle");
  const [review, setReview] = useState<MockReview | null>(initialReview);

  // Read only in handlers and timers, never while rendering.
  const draftRef = useRef(draft);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLeft = useRef(Number.POSITIVE_INFINITY);
  const handingRef = useRef(false);
  const autoTried = useRef(false);

  // --- building ---------------------------------------------------------------
  useEffect(() => {
    if (phase.kind !== "building") return;
    let live = true;
    buildMock(mock.id, (state) => {
      if (live) setProgress(state);
    })
      .then((state) => {
        if (!live) return;
        if (state.status === "building") {
          setNotice("Writing questions is taking longer than usual. Try again in a moment; nothing is lost.");
        } else {
          setPhase({ kind: "intro", count: state.built, short: Boolean(state.short) });
        }
      })
      .catch((err: unknown) => {
        if (live) setNotice(errorText(err, AI_BUSY_POLYA_STUDY));
      });
    return () => {
      live = false;
    };
  }, [phase.kind, mock.id, buildTry]);

  // --- answers kept on this device -----------------------------------------
  const commit = useCallback(
    (next: MockDraft) => {
      draftRef.current = next;
      setDraft(next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // Private browsing or full storage: the answers still live in the page.
        }
      }, 300);
    },
    [storageKey],
  );

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  // --- the clock ----------------------------------------------------------------
  async function begin() {
    setStarting(true);
    setNotice(null);
    try {
      const result = await invokeFunction<StartResult>("polya-study", { action: "start_mock", mock_id: mock.id });
      if (!result.mock.due_at) throw new Error("no due time");
      const t = Date.now();
      const skew = Date.parse(result.server_now) - t;
      let saved = emptyMockDraft(result.questions);
      try {
        saved = parseMockDraft(window.localStorage.getItem(storageKey), result.questions);
      } catch {
        // Storage unavailable: start from blank answers.
      }
      draftRef.current = saved;
      prevLeft.current = remainingMs(result.mock.due_at, skew, t);
      autoTried.current = false;
      setQuestions(result.questions);
      setDraft(saved);
      setClock({ dueAt: result.mock.due_at, skew });
      setNow(t);
      setPhase({ kind: "running" });
    } catch (err) {
      setNotice(errorText(err, AI_BUSY_POLYA_STUDY));
    } finally {
      setStarting(false);
    }
  }

  const handIn = useCallback(
    async (auto: boolean) => {
      if (handingRef.current) return;
      handingRef.current = true;
      setHandingIn(auto ? "auto" : "manual");
      setConfirming(false);
      setNotice(null);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const current = draftRef.current;
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(current));
      } catch {
        // Nothing to do: the answers are still in the page.
      }
      try {
        const result = await invokeFunction<MockReview>("polya-study", {
          action: "submit_mock",
          mock_id: mock.id,
          answers: questions.map((q) => ({
            question_id: q.id,
            responses: responsesFromDrafts(q.parts, current.answers[q.id] ?? q.parts.map(() => emptyDraft())),
          })),
        });
        try {
          window.localStorage.removeItem(storageKey);
        } catch {
          // Leftover answers are harmless; they're ignored once handed in.
        }
        setReview(result);
        setPhase({ kind: "report" });
      } catch (err) {
        handingRef.current = false;
        setHandingIn("idle");
        setNotice(errorText(err, SUBMIT_BUSY));
      }
    },
    [mock.id, questions, storageKey],
  );

  useEffect(() => {
    if (phase.kind !== "running" || !clock) return;
    const tick = () => {
      const t = Date.now();
      const left = remainingMs(clock.dueAt, clock.skew, t);
      const warning = warningCrossed(prevLeft.current, left);
      prevLeft.current = left;
      setNow(t);
      if (warning) setAnnouncement(warning);
      if (left <= 0 && !autoTried.current) {
        autoTried.current = true;
        void handIn(true);
      }
    };
    const timer = setInterval(tick, 1000);
    // Background tabs slow timers down; catch up the moment the page is back.
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [phase.kind, clock, handIn]);

  // --- report -------------------------------------------------------------------
  if (phase.kind === "report") {
    return review ? (
      <MockReport courseId={courseId} examId={examId} mockId={mock.id} title={mock.title} minutes={mock.minutes} review={review} topics={topics} />
    ) : (
      <Centered>
        <h2 className="text-[19px]">{mock.title}</h2>
        <p className="m-0 text-[13px] leading-[1.65] text-ink2">
          This mock exam was handed in, but its report couldn&apos;t be loaded just now. Refresh the page to try again.
        </p>
        <Link href={examHref} className="button-secondary h-9 self-start px-4 text-[13px]">
          Back to the exam
        </Link>
      </Centered>
    );
  }

  // --- before the clock starts --------------------------------------------------
  if (phase.kind !== "running") {
    return (
      <Centered>
        <p className="eyebrow m-0">Mock exam · {examTitle}</p>
        <h2 className="text-[21px]">{mock.title}</h2>

        {phase.kind === "building" ? (
          <>
            <div role="status" className="flex items-center gap-3 rounded-[10px] border border-line-soft bg-rail px-4 py-5">
              <span className="flex gap-1" aria-hidden>
                <span className="h-1.5 w-1.5 animate-dot-pulse rounded-full bg-accent" />
                <span className="h-1.5 w-1.5 animate-dot-pulse rounded-full bg-accent [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-dot-pulse rounded-full bg-accent [animation-delay:300ms]" />
              </span>
              <span className="text-[13px] text-ink2">
                Writing your questions
                {progress && progress.total > 0 ? `… ${progress.built} of ${progress.total}` : "…"} Every answer is
                checked twice, so this can take a few minutes. You can leave and come back.
              </span>
            </div>
          </>
        ) : null}

        {phase.kind === "intro" ? (
          <>
            <p className="m-0 font-mono text-[12.5px] text-ink3">
              {mock.minutes} min · {phase.count} question{phase.count === 1 ? "" : "s"}
            </p>
            {phase.short ? (
              <p className="m-0 rounded-lg bg-rail px-3.5 py-3 text-[12.5px] text-ink2">
                This mock has fewer questions than planned: Polya wrote as many as it could check today.
              </p>
            ) : null}
            <p className="m-0 text-[13.5px] leading-[1.7] text-ink2">
              No hints, no answers, no checking until you hand it in, like the real thing. The clock keeps running if
              you leave this page.
            </p>
            <button
              type="button"
              onClick={() => void begin()}
              disabled={starting}
              className="button-primary h-10 cursor-pointer self-start px-5 disabled:opacity-60"
            >
              {starting ? "Starting…" : "Start the clock"}
            </button>
          </>
        ) : null}

        {phase.kind === "resume" ? (
          <>
            <p className="m-0 text-[13.5px] leading-[1.7] text-ink2">
              You&apos;re {minutesIn} minute{minutesIn === 1 ? "" : "s"} in. The clock kept running while you were away.
            </p>
            <button
              type="button"
              onClick={() => void begin()}
              disabled={starting}
              className="button-primary h-10 cursor-pointer self-start px-5 disabled:opacity-60"
            >
              {starting ? "Opening…" : "Pick up where you left off"}
            </button>
          </>
        ) : null}

        {notice ? (
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg bg-rail px-3.5 py-3 text-[12.5px] text-ink2">
            <span className="min-w-0 flex-1">{notice}</span>
            {phase.kind === "building" ? (
              <button
                type="button"
                onClick={() => {
                  setNotice(null);
                  setBuildTry((n) => n + 1);
                }}
                className="button-secondary h-8 cursor-pointer text-[12.5px]"
              >
                Try again
              </button>
            ) : null}
          </div>
        ) : null}

        <Link href={examHref} className="self-start text-[12.5px] text-ink3 underline hover:text-ink">
          Back to the exam
        </Link>
      </Centered>
    );
  }

  // --- running ------------------------------------------------------------------
  const left = clock ? remainingMs(clock.dueAt, clock.skew, now) : 0;
  const index = Math.min(draft.current, Math.max(0, questions.length - 1));
  const question = questions[index];
  const drafts: Draft[] = question ? draft.answers[question.id] ?? question.parts.map(() => emptyDraft()) : [];
  const flagged = question ? draft.flagged.includes(question.id) : false;
  const locked = handingIn !== "idle";
  const unfinished = unfinishedNotice(questions, draft);

  const goTo = (i: number) => {
    if (i < 0 || i >= questions.length) return;
    commit({ ...draftRef.current, current: i });
  };
  const updatePart = (partIndex: number, patch: Partial<Draft>) => {
    if (!question) return;
    const base = draftRef.current;
    const list = base.answers[question.id] ?? question.parts.map(() => emptyDraft());
    commit({
      ...base,
      answers: { ...base.answers, [question.id]: list.map((d, i) => (i === partIndex ? { ...d, ...patch } : d)) },
    });
  };
  const toggleFlag = () => {
    if (!question) return;
    const base = draftRef.current;
    commit({
      ...base,
      flagged: base.flagged.includes(question.id) ? base.flagged.filter((id) => id !== question.id) : [...base.flagged, question.id],
    });
  };
  const requestHandIn = () => {
    if (unfinishedNotice(questions, draftRef.current)) setConfirming(true);
    else void handIn(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-2.5 sm:px-6">
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{mock.title}</span>
        <span
          role="timer"
          aria-label="Time left"
          className={`shrink-0 rounded-md px-2.5 py-1 font-mono text-[13px] tabular-nums ${
            left <= FIVE_MINUTES ? "bg-amber-soft text-amber" : "bg-rail text-ink2"
          }`}
        >
          {formatRemaining(left)}
        </span>
        <button
          type="button"
          onClick={requestHandIn}
          disabled={locked}
          className="button-primary h-8 shrink-0 cursor-pointer px-3.5 text-[12.5px] disabled:opacity-60"
        >
          {handingIn === "manual" ? "Handing in…" : "Hand it in"}
        </button>
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <nav
          aria-label="Questions"
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              goTo(index + 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              goTo(index - 1);
            }
          }}
          className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-line-soft bg-rail px-4 py-2.5 lg:w-[200px] lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:border-r lg:border-b-0 lg:px-3 lg:py-4"
        >
          <span className="hidden px-1 pb-1 text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3 lg:block">
            {answeredCount(questions, draft)} of {questions.length} answered
          </span>
          {questions.map((q, i) => {
            const answered = isAnswered(q, draft);
            const isFlagged = draft.flagged.includes(q.id);
            const label = `Question ${i + 1}${answered ? ", answered" : ""}${isFlagged ? ", flagged" : ""}`;
            return (
              <button
                key={q.id}
                type="button"
                onClick={() => goTo(i)}
                aria-label={label}
                aria-current={i === index ? "step" : undefined}
                className={`flex h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2 text-[12.5px] lg:justify-start lg:px-2.5 ${
                  i === index
                    ? "border-accent bg-accent-soft font-semibold text-accent-ink"
                    : answered
                    ? "border-line bg-surface text-ink"
                    : "border-line-soft text-ink3 hover:border-ink3"
                }`}
              >
                <span className="font-mono">{i + 1}</span>
                <span className="hidden lg:inline">{answered ? "Answered" : "Not yet"}</span>
                {isFlagged ? (
                  <span aria-hidden className="text-amber">
                    ⚑
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-[680px] flex-col gap-5 px-5 pt-6 pb-14 sm:px-8">
            {handingIn === "auto" ? (
              <p role="status" className="m-0 rounded-lg bg-amber-soft px-3.5 py-3 text-[12.5px] text-amber">
                Time&apos;s up. Handing in your answers…
              </p>
            ) : null}
            {notice ? (
              <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-rail px-3.5 py-3 text-[12.5px] text-ink2">
                <span className="min-w-0 flex-1">{notice}</span>
                <button type="button" onClick={() => void handIn(left <= 0)} className="button-secondary h-8 cursor-pointer text-[12.5px]">
                  Try again
                </button>
              </div>
            ) : null}
            {confirming && unfinished ? (
              <div role="alertdialog" aria-label="Hand it in?" className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface px-4 py-3.5 shadow-card">
                <p className="m-0 text-[13.5px]">{unfinished} Hand it in anyway?</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void handIn(false)} className="button-primary h-8 cursor-pointer px-3.5 text-[12.5px]">
                    Hand it in
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className="button-secondary h-8 cursor-pointer px-3.5 text-[12.5px]">
                    Keep working
                  </button>
                </div>
              </div>
            ) : null}

            {question ? (
              <article className="flex flex-col gap-5">
                <div className="flex items-center gap-3">
                  <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">
                    Question {index + 1} of {questions.length}
                  </span>
                  <button
                    type="button"
                    onClick={toggleFlag}
                    aria-pressed={flagged}
                    disabled={locked}
                    className={`ml-auto h-7 cursor-pointer rounded-md border px-2.5 text-[12px] ${
                      flagged ? "border-amber bg-amber-soft text-amber" : "border-line text-ink2 hover:border-ink3"
                    }`}
                  >
                    {flagged ? "Flagged for review" : "Flag for review"}
                  </button>
                </div>
                <div className="text-[14.5px] leading-[1.75] whitespace-pre-line text-ink">
                  <MathText text={question.stem} />
                </div>
                {question.parts.map((part, i) => (
                  <PartField
                    key={`${question.id}-${i}`}
                    part={part}
                    index={i}
                    count={question.parts.length}
                    name={`${baseId}-${question.id}-p${i}`}
                    draft={drafts[i] ?? emptyDraft()}
                    onChange={(patch) => updatePart(i, patch)}
                    disabled={locked}
                  />
                ))}
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => goTo(index - 1)}
                    disabled={index === 0}
                    className="button-secondary h-9 cursor-pointer px-3.5 text-[12.5px] disabled:cursor-default disabled:opacity-40"
                  >
                    ← Previous
                  </button>
                  {index < questions.length - 1 ? (
                    <button type="button" onClick={() => goTo(index + 1)} className="button-secondary h-9 cursor-pointer px-3.5 text-[12.5px]">
                      Next →
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={requestHandIn}
                      disabled={locked}
                      className="button-primary h-9 cursor-pointer px-3.5 text-[12.5px] disabled:opacity-60"
                    >
                      Hand it in
                    </button>
                  )}
                  <span className="ml-auto text-[11.5px] text-ink3 lg:hidden">
                    {answeredCount(questions, draft)} of {questions.length} answered
                  </span>
                </div>
              </article>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[560px] flex-col gap-4 px-5 pt-12 pb-14 sm:px-8">{children}</div>
    </div>
  );
}
