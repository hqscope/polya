"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import CoachRail, { type RailOverride, type RailTab } from "@/components/coach/CoachRail";
import CoachThread, { type CardState, type Shared } from "@/components/coach/CoachThread";
import { QuickReplies, StageBadge, type TrackerTopic } from "@/components/coach/blocks";
import ExamFiles from "@/components/study/ExamFiles";
import ExamForm from "@/components/study/ExamForm";
import PracticeSession from "@/components/study/PracticeSession";
import TopicMap from "@/components/study/TopicMap";
import MaterialUpload from "@/components/import/MaterialUpload";
import BottomSheet from "@/components/ui/BottomSheet";
import SourceSheet from "@/components/viewer/SourceSheet";
import { AI_BUSY_POLYA_STUDY } from "@/lib/ai-busy";
import { POLYA_CHAT_RETRY, POLYA_CHAT_STOP } from "@/lib/chat-failure";
import {
  appendBlock,
  appendDelta,
  applyCoachBlock,
  latestPlanKey,
  latestReplies,
  localToday,
  togglePlanItem,
  type CoachMessage,
  type RailState,
} from "@/lib/coach";
import { streamCoach, type CoachEvent, type CoachStatus } from "@/lib/coach-stream";
import { FunctionError, invokeFunction } from "@/lib/functions";
import type { BuildState } from "@/lib/mock-client";
import type { TutorSource } from "@/lib/sse";
import {
  examDateLabel,
  scoreLabel,
  type AttemptRow,
  type CourseFile,
  type ExamFileMark,
  type ExamRow,
  type GradedAttempt,
  type MockRow,
  type PartResponse,
  type QuestionRow,
  type StudyErrorRow,
  type TopicRow,
} from "@/lib/study";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { useMediaQuery, WIDE_LAYOUT_QUERY } from "@/lib/use-media-query";
import { POLYA_ERROR_OFFLINE, userMessage } from "@/lib/user-message";
import { errorStatus, progressByTopic, stagesByTopic } from "../../../supabase/functions/_shared/study-progress.ts";
import type { CoachQuestion } from "../../../supabase/functions/_shared/coach-blocks.ts";

interface Props {
  courseId: string;
  exam: ExamRow;
  topics: TopicRow[];
  questions: QuestionRow[];
  attempts: AttemptRow[];
  marks: ExamFileMark[];
  files: CourseFile[];
  errors: StudyErrorRow[];
  mocks: MockRow[];
  conversationId: string | null;
  initialMessages: CoachMessage[];
  initialCards: Record<string, CardState>;
  /** Back from a handed-in mock exam ("Review with Polya"). */
  reviewMockId: string | null;
}

type Turn = { message: string } | { event: CoachEvent; label: string | null };
type Failure = { message: string; canRetry: boolean; turn: Turn };

const TOPIC_SELECT = "id, position, title, summary, key_formulas, source_ids, origin, stage";
const PASSTHROUGH = new Set(["too_long", "rate_limited", "unauthorized", "busy"]);

function failureFor(code: string | undefined, message: string, turn: Turn): Failure {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { message: POLYA_ERROR_OFFLINE, canRetry: true, turn };
  }
  if (code && PASSTHROUGH.has(code)) return { message, canRetry: code !== "too_long", turn };
  return { message: "Polya couldn't answer just now.", canRetry: true, turn };
}

function fileSource(sourceId: string, title: string): TutorSource {
  return {
    n: 0,
    unit_id: "",
    source_id: sourceId,
    title,
    unit_type: "document",
    page_start: 1,
    page_end: null,
    t_start_ms: null,
    t_end_ms: null,
    snippet: "",
  };
}

// The exam coach: one conversation per exam that teaches, puts practice
// questions in front of the student, keeps the plan, tracks each topic's stage
// and the mistakes worth fixing, and sets up timed mock exams.
export default function CoachView(props: Props) {
  const { courseId } = props;
  const [exam, setExam] = useState(props.exam);
  const [rail, setRail] = useState<RailState>({
    plan: props.exam.plan ?? null,
    topics: props.topics,
    errors: props.errors,
    mocks: props.mocks,
  });
  const [questions, setQuestions] = useState(props.questions);
  const [attempts, setAttempts] = useState(props.attempts);
  const [marks, setMarks] = useState(props.marks);
  const [messages, setMessages] = useState<CoachMessage[]>(props.initialMessages);
  const [cards, setCards] = useState<Record<string, CardState>>(props.initialCards);
  const [conversationId, setConversationId] = useState(props.conversationId);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<CoachStatus | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [tab, setTab] = useState<RailTab>("plan");
  const [override, setOverride] = useState<RailOverride>(null);
  const [sheet, setSheet] = useState<"rail" | "details" | null>(null);
  const [sheetSource, setSheetSource] = useState<TutorSource | null>(null);
  const [drill, setDrill] = useState<{ topicId: string | null } | null>(null);
  const [editingExam, setEditingExam] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [activeCitation, setActiveCitation] = useState<{ messageId: string; n: number } | null>(null);
  const [sourcesFor, setSourcesFor] = useState<string | null>(null);
  const [today] = useState(() => localToday());
  const [now, setNow] = useState(() => Date.now());
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const queue = useRef<Turn[]>([]);
  const busyRef = useRef(false);
  const localCounter = useRef(0);
  const conversationRef = useRef(conversationId);
  const started = useRef(false);

  const topicTitle = useCallback((id: string) => rail.topics.find((t) => t.id === id)?.title ?? null, [rail.topics]);

  // --- the rail follows the database after a turn changes anything -----------
  const resync = useCallback(async () => {
    const supabase = createBrowserSupabaseClient();
    const [topics, examRow, errors, mocks] = await Promise.all([
      supabase.from("polya_study_topics").select(TOPIC_SELECT).eq("exam_id", exam.id).order("position", { ascending: true }),
      supabase.from("polya_exams").select("plan").eq("id", exam.id).maybeSingle(),
      supabase
        .from("polya_study_errors")
        .select("id, topic_id, question_id, what, why, fix, created_at")
        .eq("exam_id", exam.id)
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("polya_mock_exams")
        .select("id, title, minutes, status, question_ids, started_at, due_at, submitted_at, score, created_at")
        .eq("exam_id", exam.id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    setRail((current) => ({
      plan: examRow.error ? current.plan : ((examRow.data?.plan as RailState["plan"]) ?? null),
      topics: topics.error ? current.topics : ((topics.data ?? []) as TopicRow[]),
      errors: errors.error ? current.errors : ((errors.data ?? []) as StudyErrorRow[]),
      mocks: mocks.error ? current.mocks : ((mocks.data ?? []) as MockRow[]),
    }));
    setNow(Date.now());
  }, [exam.id]);

  // --- one coach turn ------------------------------------------------------------
  const runTurn = useCallback(
    async (turn: Turn) => {
      if (busyRef.current) {
        if ("event" in turn) queue.current.push(turn);
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setStatus(null);
      setFailure(null);
      setNotice(null);
      nearBottom.current = true;

      const n = ++localCounter.current;
      const promptId = `local-${n}-in`;
      const replyId = `local-${n}-out`;
      const prompt: CoachMessage | null = "message" in turn
        ? { localId: promptId, kind: "user", text: turn.message }
        : turn.label
        ? { localId: promptId, kind: "event", label: turn.label }
        : null;
      setMessages((prev) => [
        ...prev,
        ...(prompt ? [prompt] : []),
        { localId: replyId, kind: "assistant", segments: [], sources: [], streaming: true },
      ]);
      if ("message" in turn) setInput("");

      const update = (fn: (m: Extract<CoachMessage, { kind: "assistant" }>) => CoachMessage) =>
        setMessages((prev) => prev.map((m) => (m.localId === replyId && m.kind === "assistant" ? fn(m) : m)));
      let received = false;
      let blocks = 0;
      let settled = false;
      const controller = new AbortController();
      abortRef.current = controller;

      const undo = () => {
        setMessages((prev) => prev.filter((m) => m.localId !== replyId && m.localId !== promptId));
        if ("message" in turn) setInput((current) => (current.trim() ? current : turn.message));
      };
      const finish = () => {
        settled = true;
        abortRef.current = null;
        busyRef.current = false;
        update((m) => ({ ...m, streaming: false }));
        setBusy(false);
        setStatus(null);
        if (blocks > 0) void resync();
      };
      const fail = (message: string, code?: string) => {
        if (!received) undo();
        // Already done (a reload resent an event): nothing to show.
        if (code !== "conflict") setFailure(failureFor(code, message, turn));
        finish();
      };

      try {
        await streamCoach(
          {
            exam_id: exam.id,
            conversation_id: conversationRef.current ?? undefined,
            client_today: today,
            ...("message" in turn ? { message: turn.message } : { event: turn.event }),
          },
          {
            onSources: ({ sources, conversation_id }) => {
              conversationRef.current = conversation_id;
              setConversationId(conversation_id);
              update((m) => ({ ...m, sources }));
            },
            onStatus: (state) => setStatus(state),
            onDelta: (text) => {
              received = true;
              setStatus(null);
              update((m) => ({ ...m, segments: appendDelta(m.segments, text) }));
            },
            onBlock: (block) => {
              received = true;
              blocks++;
              setStatus(null);
              update((m) => ({ ...m, segments: appendBlock(m.segments, block) }));
              setRail((current) => applyCoachBlock(current, block));
            },
            onDone: () => {
              if (!settled) finish();
            },
            onError: (message, code) => {
              if (!settled) fail(message, code);
            },
          },
          controller.signal,
        );
        if (!settled) fail("Polya couldn't answer just now.");
      } catch {
        if (settled) return;
        if (controller.signal.aborted) {
          // Stopped: keep what arrived; stopped before anything, undo the turn.
          if (!received) undo();
          finish();
          return;
        }
        fail("Polya couldn't answer just now.");
      }
    },
    [exam.id, resync, today],
  );

  // Answers that arrive mid-turn wait their turn, in order.
  useEffect(() => {
    if (busy || queue.current.length === 0) return;
    const timer = setTimeout(() => {
      const next = queue.current.shift();
      if (next) void runTurn(next);
    }, 0);
    return () => clearTimeout(timer);
  }, [busy, runTurn]);

  // Leaving the page mid-answer stops the stream (the server still saves it).
  useEffect(() => () => abortRef.current?.abort(), []);

  // First visit: map the exam's topics if there are none, then open the coach.
  // Back from a mock exam: go over it. Deferred a tick so Strict Mode's
  // mount-unmount-mount sends each exactly once.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (started.current) return;
      started.current = true;
      const turns: Turn[] = [];
      if (props.initialMessages.length === 0 && !props.conversationId) turns.push({ event: { kind: "open" }, label: null });
      const review = props.reviewMockId ? props.mocks.find((m) => m.id === props.reviewMockId) : null;
      if (review && review.status === "submitted") {
        turns.push({
          event: { kind: "mock_submitted", mock_id: review.id },
          label: `You handed in ${review.title}${review.score !== null ? ` · ${Math.round(review.score * 100)}%` : ""}`,
        });
      }
      if (props.reviewMockId) window.history.replaceState(window.history.state, "", window.location.pathname);
      void (async () => {
        if (turns[0] && "event" in turns[0] && turns[0].event.kind === "open" && props.topics.length === 0) {
          setSuggesting(true);
          try {
            const result = await invokeFunction<{ topics: TopicRow[] }>("polya-study", { action: "propose_topics", exam_id: props.exam.id });
            setRail((current) => ({ ...current, topics: result.topics }));
          } catch (err) {
            // The coach still opens; it teaches from the scope note and suggests topics.
            if (!(err instanceof FunctionError && err.code === "conflict")) console.warn("[polya] topic suggestion failed:", err);
          } finally {
            setSuggesting(false);
          }
        }
        for (const turn of turns) void runTurn(turn);
      })();
    }, 0);
    return () => clearTimeout(timer);
    // Runs once, on the props the page loaded with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- scrolling: follow the stream only when the reader is at the bottom ---------
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottom.current) el.scrollTo({ top: el.scrollHeight });
  }, [messages, status]);

  useLayoutEffect(() => {
    const box = inputRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, [input]);

  // --- handlers the thread and rail call -----------------------------------------
  const onGraded = useCallback(
    (question: CoachQuestion, graded: GradedAttempt, responses: PartResponse[]) => {
      setCards((current) => ({ ...current, [question.id]: { graded, responses } }));
      const topicIds = graded.topic_ids ?? question.topic_ids ?? [];
      if (topicIds[0]) {
        setAttempts((current) => [
          {
            id: graded.attempt_id ?? undefined,
            question_id: question.id,
            topic_id: topicIds[0]!,
            topic_ids: topicIds,
            score: graded.score,
            all_correct: graded.all_correct,
            created_at: graded.created_at ?? new Date().toISOString(),
          },
          ...current,
        ]);
      }
      setNow(Date.now());
      if (graded.attempt_id) {
        void runTurn({
          event: { kind: "attempt", attempt_id: graded.attempt_id },
          label: `You answered a question · ${scoreLabel(question.parts, graded.results)}`,
        });
      }
    },
    [runTurn],
  );

  const openSource = useCallback(
    (source: TutorSource) => {
      if (wide) {
        setOverride({ kind: "source", source });
      } else {
        setSheet(null);
        setSheetSource(source);
      }
    },
    [wide],
  );

  const onCite = useCallback(
    (messageId: string, n: number) => {
      const message = messages.find((m) => m.localId === messageId);
      if (!message || message.kind !== "assistant") return;
      const source = message.sources.find((s) => s.n === n);
      if (!source) return;
      setActiveCitation({ messageId, n });
      setSourcesFor(messageId);
      openSource(source);
    },
    [messages, openSource],
  );

  const openDetails = useCallback(() => {
    if (wide) setOverride({ kind: "details" });
    else setSheet("details");
  }, [wide]);

  const onTogglePlan = useCallback(
    (itemId: string, done: boolean) => {
      setRail((current) => (current.plan ? { ...current, plan: togglePlanItem(current.plan, itemId, done) } : current));
      invokeFunction("polya-study", { action: "toggle_plan_item", exam_id: exam.id, item_id: itemId, done }).catch((err) => {
        setRail((current) => (current.plan ? { ...current, plan: togglePlanItem(current.plan, itemId, !done) } : current));
        setNotice(userMessage(err));
      });
    },
    [exam.id],
  );

  const onMockBuilt = useCallback((mockId: string, state: BuildState) => {
    setRail((current) => ({
      ...current,
      mocks: current.mocks.map((m) => (m.id === mockId ? { ...m, status: state.status } : m)),
    }));
  }, []);

  const onClearError = useCallback(
    async (id: string) => {
      const before = rail.errors;
      setRail((current) => ({ ...current, errors: current.errors.filter((e) => e.id !== id) }));
      const { error } = await createBrowserSupabaseClient().from("polya_study_errors").delete().eq("id", id);
      if (error) {
        setRail((current) => ({ ...current, errors: before }));
        setNotice(userMessage(error));
      }
    },
    [rail.errors],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busyRef.current) return;
      void runTurn({ message: trimmed });
    },
    [runTurn],
  );

  async function suggestTopics() {
    setSuggesting(true);
    setNotice(null);
    try {
      const result = await invokeFunction<{ topics: TopicRow[] }>("polya-study", { action: "propose_topics", exam_id: exam.id });
      setRail((current) => ({ ...current, topics: result.topics }));
    } catch (err) {
      setNotice(err instanceof FunctionError && err.code === "busy" ? AI_BUSY_POLYA_STUDY : userMessage(err));
    } finally {
      setSuggesting(false);
    }
  }

  // --- derived ---------------------------------------------------------------
  const stages = useMemo(() => stagesByTopic(rail.topics, attempts, now), [rail.topics, attempts, now]);
  const progress = useMemo(() => progressByTopic(rail.topics, attempts), [rail.topics, attempts]);
  const tracker: TrackerTopic[] = rail.topics.map((t) => {
    const info = stages.get(t.id);
    return {
      id: t.id,
      title: t.title,
      stage: info?.stage ?? "not_started",
      accuracy: info?.progress.accuracy ?? null,
      attempts: info?.progress.attempts ?? 0,
    };
  });
  const errors = useMemo(() => errorStatus(rail.errors, attempts), [rail.errors, attempts]);
  const ready = tracker.filter((t) => t.stage === "exam_ready").length;
  const reserved = useMemo(
    () => new Set(rail.mocks.filter((m) => m.status !== "submitted").flatMap((m) => m.question_ids)),
    [rail.mocks],
  );
  const openMock = rail.mocks.find((m) => m.status === "ready" || m.status === "in_progress" || m.status === "building");
  const replies = busy ? [] : latestReplies(messages);
  const planKey = latestPlanKey(messages);
  const when = examDateLabel(exam.exam_date);
  const daysLeft = exam.exam_date ? Math.round((Date.parse(`${exam.exam_date}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86_400_000) : null;

  const sourcesMessage = (() => {
    const chosen = sourcesFor ? messages.find((m) => m.localId === sourcesFor) : null;
    if (chosen && chosen.kind === "assistant") return chosen;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.kind === "assistant" && m.sources.length > 0) return m;
    }
    return null;
  })();

  const shared: Shared = useMemo(
    () => ({
      courseId,
      examId: exam.id,
      today,
      cards,
      topicTitle,
      mocks: rail.mocks,
      latestPlanKey: planKey,
      onCite,
      onGraded,
      onOpenSource: openSource,
      onOpenFile: (sourceId: string, title: string) => openSource(fileSource(sourceId, title)),
      onAddMaterials: openDetails,
      onTogglePlan,
      onMockBuilt,
    }),
    [courseId, exam.id, today, cards, topicTitle, rail.mocks, planKey, onCite, onGraded, openSource, openDetails, onTogglePlan, onMockBuilt],
  );

  const details = (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">This exam</span>
          <button type="button" onClick={() => setEditingExam((on) => !on)} className="ml-auto cursor-pointer text-[12px] text-ink3 underline hover:text-ink">
            {editingExam ? "Close" : "Edit details"}
          </button>
        </div>
        {editingExam ? (
          <ExamForm
            courseId={courseId}
            files={props.files}
            exam={exam}
            onSaved={(saved) => {
              setExam((current) => ({ ...current, ...saved }));
              setEditingExam(false);
            }}
            onCancel={() => setEditingExam(false)}
          />
        ) : (
          <p className="m-0 text-[12.5px] leading-[1.6] text-ink2">
            {exam.scope_note?.trim() ? exam.scope_note.slice(0, 280) : "Add what the instructor said the exam covers, so Polya can focus on it."}
          </p>
        )}
      </section>
      {rail.topics.length === 0 ? (
        <button type="button" onClick={() => void suggestTopics()} disabled={suggesting} className="button-secondary h-9 cursor-pointer self-start text-[12.5px] disabled:opacity-60">
          {suggesting ? "Reading your course…" : "Suggest topics"}
        </button>
      ) : null}
      <TopicMap
        examId={exam.id}
        topics={rail.topics}
        progress={progress}
        onChange={(topics) => setRail((current) => ({ ...current, topics }))}
        onPractice={(topicId) => {
          setOverride(null);
          setSheet(null);
          setDrill({ topicId });
        }}
        badge={(topic) => <StageBadge stage={stages.get(topic.id)?.stage ?? "not_started"} />}
      />
      <ExamFiles examId={exam.id} files={props.files} marks={marks} onChange={setMarks} />
      <MaterialUpload courseId={courseId} />
    </div>
  );

  const railProps = {
    tab,
    onTab: setTab,
    details,
    courseId,
    examId: exam.id,
    today,
    plan: rail.plan,
    onTogglePlan,
    onAsk: send,
    busy,
    tracker,
    onDrill: (topicId: string) => {
      setSheet(null);
      setDrill({ topicId });
    },
    mocks: rail.mocks,
    errors,
    topicTitle,
    onClearError: (id: string) => void onClearError(id),
    sources: sourcesMessage?.sources ?? [],
    activeCitation: activeCitation?.messageId === sourcesMessage?.localId ? activeCitation?.n ?? null : null,
    onSelectSource: (n: number) => sourcesMessage && onCite(sourcesMessage.localId, n),
  };

  if (drill) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center border-b border-line-soft px-4 sm:px-7">
          <button type="button" onClick={() => setDrill(null)} className="cursor-pointer text-[12.5px] font-medium text-ink3 hover:text-ink">
            ← Back to your coach
          </button>
        </div>
        <PracticeSession
          courseId={courseId}
          examId={exam.id}
          topics={rail.topics}
          questions={questions}
          attempts={attempts}
          topicId={drill.topicId}
          reservedIds={reserved}
          onBack={() => setDrill(null)}
          onQuestionsAdded={(added) => setQuestions((current) => [...added, ...current])}
          onAttempt={(attempt) => {
            setAttempts((current) => [attempt, ...current]);
            setNow(Date.now());
          }}
          onReported={(questionId) =>
            setQuestions((current) => current.map((q) => (q.id === questionId ? { ...q, status: "flagged" } : q)))
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Exam bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line-soft px-4 py-2 sm:px-7">
        <h2 className="min-w-0 truncate text-[15px]">{exam.title}</h2>
        {when ? (
          <span
            className={`shrink-0 rounded-full px-2 py-[2px] text-[11px] font-semibold ${
              daysLeft !== null && daysLeft >= 0 && daysLeft <= 3 ? "bg-amber-soft text-amber" : "bg-line-soft text-ink2"
            }`}
          >
            {when}
          </span>
        ) : null}
        {tracker.length > 0 ? (
          <span className="hidden shrink-0 text-[11.5px] text-ink3 sm:inline">
            {ready} of {tracker.length} topics exam-ready
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setDrill({ topicId: null })}
            disabled={rail.topics.length === 0}
            className="button-secondary h-7 cursor-pointer rounded-md px-2.5 text-[12px] disabled:opacity-50"
          >
            Drill weak spots
          </button>
          {openMock && openMock.status !== "building" ? (
            <Link href={`/app/courses/${courseId}/study/${exam.id}/mock/${openMock.id}`} className="button-secondary h-7 rounded-md px-2.5 text-[12px]">
              {openMock.status === "in_progress" ? "Resume mock" : "Start mock"}
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => send("I'd like a timed mock exam.")}
              disabled={busy || Boolean(openMock)}
              className="button-secondary hidden h-7 cursor-pointer rounded-md px-2.5 text-[12px] disabled:opacity-50 sm:inline-flex"
            >
              Mock exam
            </button>
          )}
          <button type="button" onClick={openDetails} className="button-secondary hidden h-7 cursor-pointer rounded-md px-2.5 text-[12px] lg:inline-flex">
            Exam details
          </button>
          <button type="button" onClick={() => setSheet("rail")} className="button-secondary h-7 cursor-pointer rounded-md px-2.5 text-[12px] lg:hidden">
            Plan &amp; progress
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
            }}
            className="min-h-0 flex-1 overflow-y-auto px-4 pt-[26px] pb-2.5 sm:px-7"
          >
            <div className="mx-auto flex max-w-[700px] flex-col gap-[22px]">
              {messages.length === 0 && !busy ? (
                <div role="status" className="flex flex-col items-center gap-2 pt-16 text-center">
                  <p className="eyebrow">{exam.title}</p>
                  <p className="m-0 flex items-center gap-2 text-[13px] text-ink2">
                    <span className="h-1.5 w-1.5 animate-dot-pulse rounded-full bg-accent" aria-hidden />
                    {suggesting ? "Mapping out what this exam covers…" : `Looking through your course for ${exam.title}…`}
                  </p>
                </div>
              ) : null}
              <CoachThread messages={messages} busy={busy} status={status} activeCitation={activeCitation} shared={shared} />
              {failure && !busy ? (
                <div role="status" className="flex flex-col items-start gap-2.5 rounded-lg border border-line bg-rail px-3.5 py-3 sm:flex-row sm:items-center">
                  <p className="m-0 min-w-0 flex-1 text-[13px] leading-[1.6] text-ink2">{failure.message}</p>
                  {failure.canRetry ? (
                    <button type="button" onClick={() => void runTurn(failure.turn)} className="button-secondary h-8 shrink-0 rounded-md px-3 text-[12.5px]">
                      {POLYA_CHAT_RETRY}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {notice ? (
                <p role="status" className="m-0 rounded-lg bg-rail px-3.5 py-3 text-[12.5px] text-ink2">
                  {notice}
                </p>
              ) : null}
            </div>
          </div>

          <div className="shrink-0 px-2 pt-2 pb-[max(8px,env(safe-area-inset-bottom))] sm:px-7 sm:pb-[18px]">
            <div className="mx-auto flex max-w-[700px] flex-col gap-2">
              <QuickReplies replies={replies} disabled={busy} onPick={send} />
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  send(input);
                }}
                className="flex flex-col gap-[7px] rounded-[10px] border border-line bg-surface px-2.5 py-[9px] shadow-card focus-within:border-ink3"
              >
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      send(input);
                    }
                  }}
                  rows={1}
                  aria-label="Message your exam coach"
                  placeholder="Ask about this exam, or tell Polya what to work on…"
                  className="max-h-[140px] min-h-[22px] resize-none border-none bg-transparent px-1 pt-1 text-[13.5px] leading-normal outline-none placeholder:text-ink3"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={openDetails}
                    className="h-[26px] shrink-0 cursor-pointer rounded-md border border-line px-2.5 text-[12px] font-semibold text-ink2 hover:border-accent hover:bg-accent-soft hover:text-accent-ink"
                  >
                    + Add materials
                  </button>
                  <span className="hidden min-w-0 flex-1 truncate text-[11px] text-ink3 sm:block">
                    Teach → practice → mix it up → mock exam.
                  </span>
                  {busy ? (
                    <button
                      type="button"
                      onClick={() => abortRef.current?.abort()}
                      className="ml-auto flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-line px-2.5 text-[12px] font-semibold text-ink hover:border-ink3"
                    >
                      <span aria-hidden="true" className="h-2 w-2 rounded-[2px] bg-ink" />
                      {POLYA_CHAT_STOP}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!input.trim()}
                      aria-label="Send"
                      className="ml-auto h-[26px] w-7 shrink-0 cursor-pointer rounded-md bg-btn text-[13px] text-btn-text hover:bg-btn-hover disabled:cursor-default disabled:opacity-40"
                    >
                      ↑
                    </button>
                  )}
                </div>
              </form>
            </div>
          </div>
        </div>

        <aside className="hidden min-h-0 w-[340px] shrink-0 flex-col border-l border-line bg-rail lg:flex">
          {wide ? <CoachRail {...railProps} override={override} onCloseOverride={() => setOverride(null)} /> : null}
        </aside>
      </div>

      {sheet && !wide ? (
        <BottomSheet label={sheet === "details" ? "Exam details" : "Plan and progress"} onClose={() => setSheet(null)}>
          <CoachRail
            {...railProps}
            override={sheet === "details" ? { kind: "details" } : null}
            onCloseOverride={() => setSheet(null)}
            onClose={() => setSheet(null)}
          />
        </BottomSheet>
      ) : null}
      {sheetSource && !wide ? <SourceSheet source={sheetSource} onClose={() => setSheetSource(null)} /> : null}
    </div>
  );
}
