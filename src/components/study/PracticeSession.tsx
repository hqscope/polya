"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import QuestionCard from "@/components/study/QuestionCard";
import SourcePanel from "@/components/viewer/SourcePanel";
import SourceSheet from "@/components/viewer/SourceSheet";
import { FunctionError, invokeFunction } from "@/lib/functions";
import { AI_BUSY_POLYA_STUDY } from "@/lib/ai-busy";
import { useMediaQuery, WIDE_LAYOUT_QUERY } from "@/lib/use-media-query";
import { userMessage } from "@/lib/user-message";
import type { TutorSource } from "@/lib/sse";
import type { AttemptRow, GradedAttempt, QuestionRow, TopicRow } from "@/lib/study";
import { pickNext } from "../../../supabase/functions/_shared/study-progress.ts";

interface Props {
  courseId: string;
  examId: string;
  topics: TopicRow[];
  questions: QuestionRow[];
  attempts: AttemptRow[];
  /** Practice one topic; null practices weak spots across the exam. */
  topicId: string | null;
  onBack: () => void;
  onQuestionsAdded: (questions: QuestionRow[]) => void;
  onAttempt: (attempt: AttemptRow) => void;
  onReported: (questionId: string) => void;
  /** Questions held by a mock exam that isn't handed in yet; never served here. */
  reservedIds?: ReadonlySet<string>;
}

type Notice = { tone: "info" | "warn"; text: string; retry?: boolean } | null;

// One question at a time: answer, see the worked solution, move on. New
// questions are written only when nothing unanswered (or due for another try)
// is left in the weakest topics.
export default function PracticeSession({
  courseId,
  examId,
  topics,
  questions,
  attempts,
  topicId,
  onBack,
  onQuestionsAdded,
  onAttempt,
  onReported,
  reservedIds,
}: Props) {
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [graded, setGraded] = useState<GradedAttempt | null>(null);
  const [writing, setWriting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [viewing, setViewing] = useState<TutorSource | null>(null);
  const [answered, setAnswered] = useState(0);
  const skip = useRef(new Set<string>(reservedIds));
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY);
  const topicTitle = topicId ? topics.find((t) => t.id === topicId)?.title : null;

  const writeFor = useCallback(
    async (writeTopicId: string) => {
      setWriting(true);
      setNotice(null);
      try {
        const result = await invokeFunction<{ questions: QuestionRow[]; kept: number }>("polya-study", {
          action: "generate_questions",
          exam_id: examId,
          topic_id: writeTopicId,
        });
        if (result.questions.length === 0) {
          setNotice({
            tone: "warn",
            text: "Polya couldn't write a question it was sure of for this topic. Try again, or practice another topic.",
            retry: true,
          });
          return;
        }
        onQuestionsAdded(result.questions);
        setCurrentId(result.questions[0]!.id);
      } catch (err) {
        if (err instanceof FunctionError && err.code === "busy") {
          setNotice({ tone: "info", text: AI_BUSY_POLYA_STUDY });
        } else if (err instanceof FunctionError && err.code === "rate_limited") {
          setNotice({ tone: "info", text: err.message });
        } else {
          setNotice({ tone: "warn", text: userMessage(err), retry: true });
        }
      } finally {
        setWriting(false);
      }
    },
    [examId, onQuestionsAdded],
  );

  const next = useCallback(() => {
    if (currentId) skip.current.add(currentId);
    setGraded(null);
    setViewing(null);
    setNotice(null);
    const step = pickNext({ topics, questions, attempts, now: Date.now(), topicId, skip: skip.current });
    if (step.kind === "question") {
      setCurrentId(step.questionId);
    } else if (step.kind === "write") {
      setCurrentId(null);
      void writeFor(step.topicId);
    } else {
      setCurrentId(null);
      setNotice({ tone: "info", text: "Add a topic to this exam to start practicing." });
    }
  }, [attempts, currentId, questions, topicId, topics, writeFor]);

  // Pick the first question once, on open.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    next();
  }, [next]);

  const question = currentId ? questions.find((q) => q.id === currentId) ?? null : null;

  function handleGraded(result: GradedAttempt) {
    setGraded(result);
    setAnswered((n) => n + 1);
    if (question) {
      onAttempt({
        id: result.attempt_id ?? undefined,
        question_id: question.id,
        topic_id: question.topic_id,
        topic_ids: result.topic_ids,
        score: result.score,
        all_correct: result.all_correct,
        created_at: new Date().toISOString(),
      });
    }
  }

  const openCitation = useCallback(
    (n: number) => setViewing(graded?.sources.find((source) => source.n === n) ?? null),
    [graded],
  );
  const closeViewer = useCallback(() => setViewing(null), []);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[680px] flex-col gap-6 px-5 pt-7 pb-14 sm:px-8">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button type="button" onClick={onBack} className="cursor-pointer text-[12.5px] text-ink3 hover:text-ink">
              ← Topics
            </button>
            <span className="text-[12.5px] text-ink3">·</span>
            <span className="text-[12.5px] font-semibold">{topicTitle ?? "Weak spots"}</span>
            {answered > 0 ? (
              <span className="ml-auto text-[11.5px] text-ink3">
                {answered} answered this session
              </span>
            ) : null}
          </div>

          {question ? (
            <QuestionCard
              key={question.id}
              courseId={courseId}
              question={question}
              graded={graded}
              onGraded={handleGraded}
              onCite={openCitation}
              onReported={() => onReported(question.id)}
            />
          ) : null}

          {writing ? (
            <div role="status" className="flex items-center gap-3 rounded-[10px] border border-line-soft bg-rail px-4 py-5">
              <span className="flex gap-1" aria-hidden>
                <span className="h-1.5 w-1.5 animate-dot-pulse rounded-full bg-accent" />
                <span className="h-1.5 w-1.5 animate-dot-pulse rounded-full bg-accent [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-dot-pulse rounded-full bg-accent [animation-delay:300ms]" />
              </span>
              <span className="text-[13px] text-ink2">
                Writing new questions from your course materials and checking every answer. This takes about a
                minute.
              </span>
            </div>
          ) : null}

          {notice ? (
            <div
              role="status"
              className={`flex flex-wrap items-center gap-3 rounded-lg px-3.5 py-3 text-[12.5px] ${
                notice.tone === "warn" ? "bg-amber-soft text-amber" : "bg-rail text-ink2"
              }`}
            >
              <span className="min-w-0 flex-1">{notice.text}</span>
              {notice.retry ? (
                <button type="button" onClick={next} className="button-secondary h-8 cursor-pointer text-[12.5px]">
                  Try again
                </button>
              ) : null}
            </div>
          ) : null}

          {graded ? (
            <button type="button" onClick={next} className="button-primary h-9 cursor-pointer self-start">
              Next question
            </button>
          ) : question && !writing ? (
            <button type="button" onClick={next} className="cursor-pointer self-start text-[12.5px] text-ink3 underline hover:text-ink">
              Skip for now
            </button>
          ) : null}
        </div>
      </div>

      {viewing && wide ? (
        <aside className="hidden min-h-0 w-[360px] shrink-0 flex-col border-l border-line bg-rail lg:flex">
          <SourcePanel source={viewing} onBack={closeViewer} backLabel="Close" />
        </aside>
      ) : null}
      {viewing && !wide ? <SourceSheet source={viewing} onClose={closeViewer} /> : null}
    </div>
  );
}
