"use client";

import { useCallback, useMemo, useState } from "react";

import ExamFiles from "@/components/study/ExamFiles";
import ExamForm from "@/components/study/ExamForm";
import PracticeSession from "@/components/study/PracticeSession";
import TopicMap from "@/components/study/TopicMap";
import { FunctionError, invokeFunction } from "@/lib/functions";
import { AI_BUSY_POLYA_STUDY } from "@/lib/ai-busy";
import { userMessage } from "@/lib/user-message";
import {
  examDateLabel,
  type AttemptRow,
  type CourseFile,
  type ExamFileMark,
  type ExamRow,
  type QuestionRow,
  type TopicRow,
} from "@/lib/study";
import { progressByTopic } from "../../../supabase/functions/_shared/study-progress.ts";

interface Props {
  courseId: string;
  exam: ExamRow;
  topics: TopicRow[];
  questions: QuestionRow[];
  attempts: AttemptRow[];
  marks: ExamFileMark[];
  files: CourseFile[];
}

type Mode = { kind: "overview" } | { kind: "practice"; topicId: string | null };

// One exam: its topic map and how each topic is going, the files that set its
// notation and style, and practice — across weak spots or one topic.
export default function ExamWorkspace(props: Props) {
  const { courseId, files } = props;
  const [exam, setExam] = useState(props.exam);
  const [topics, setTopics] = useState(props.topics);
  const [questions, setQuestions] = useState(props.questions);
  const [attempts, setAttempts] = useState(props.attempts);
  const [marks, setMarks] = useState(props.marks);
  const [mode, setMode] = useState<Mode>({ kind: "overview" });
  const [editingExam, setEditingExam] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const progress = useMemo(() => progressByTopic(topics, attempts), [topics, attempts]);
  const solid = topics.filter((t) => progress.get(t.id)?.status === "solid").length;
  const when = examDateLabel(exam.exam_date);

  const addQuestions = useCallback((added: QuestionRow[]) => setQuestions((current) => [...added, ...current]), []);
  const addAttempt = useCallback((attempt: AttemptRow) => setAttempts((current) => [attempt, ...current]), []);
  const markReported = useCallback(
    (questionId: string) =>
      setQuestions((current) => current.map((q) => (q.id === questionId ? { ...q, status: "flagged" } : q))),
    [],
  );

  async function suggestTopics() {
    setSuggesting(true);
    setNotice(null);
    try {
      const result = await invokeFunction<{ topics: TopicRow[] }>("polya-study", {
        action: "propose_topics",
        exam_id: exam.id,
      });
      setTopics(result.topics);
    } catch (err) {
      setNotice(err instanceof FunctionError && err.code === "busy" ? AI_BUSY_POLYA_STUDY : userMessage(err));
    } finally {
      setSuggesting(false);
    }
  }

  if (mode.kind === "practice") {
    return (
      <PracticeSession
        courseId={courseId}
        examId={exam.id}
        topics={topics}
        questions={questions}
        attempts={attempts}
        topicId={mode.topicId}
        onBack={() => setMode({ kind: "overview" })}
        onQuestionsAdded={addQuestions}
        onAttempt={addAttempt}
        onReported={markReported}
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[640px] flex-col gap-7 px-5 pt-9 pb-14 sm:px-8">
        <div className="flex flex-col gap-[7px] border-b border-line pb-[18px]">
          <div className="flex items-baseline gap-3">
            <h2 className="min-w-0 truncate text-[21px]">{exam.title}</h2>
            {when ? <span className="shrink-0 text-[12.5px] text-ink3">{when}</span> : null}
            <button
              type="button"
              onClick={() => setEditingExam((on) => !on)}
              className="ml-auto shrink-0 cursor-pointer text-[12px] text-ink3 underline hover:text-ink"
            >
              {editingExam ? "Close" : "Edit details"}
            </button>
          </div>
          {topics.length > 0 ? (
            <p className="m-0 text-[13px] text-ink2">
              {solid} of {topics.length} topic{topics.length === 1 ? "" : "s"} solid · {attempts.length} question
              {attempts.length === 1 ? "" : "s"} answered
            </p>
          ) : null}
        </div>

        {editingExam ? (
          <ExamForm
            courseId={courseId}
            files={files}
            exam={exam}
            onSaved={(saved) => {
              setExam(saved);
              setEditingExam(false);
            }}
            onCancel={() => setEditingExam(false)}
          />
        ) : null}

        {topics.length > 0 ? (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setMode({ kind: "practice", topicId: null })}
              className="button-primary h-10 cursor-pointer self-start"
            >
              Practice my weak spots
            </button>
            <span className="text-[12px] text-ink3">
              Starts with the topics you&apos;re shakiest on. Questions you miss come back the next day.
            </span>
          </div>
        ) : (
          <section className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface px-4 py-4 shadow-card">
            <h3 className="text-[15px]">Map out this exam</h3>
            <p className="m-0 text-[13px] leading-[1.65] text-ink2">
              Polya reads your scope note, formula sheet, past exams and course files and suggests the topics to
              study, in order. You can change any of them after.
            </p>
            <button
              type="button"
              onClick={() => void suggestTopics()}
              disabled={suggesting}
              className="button-primary h-9 cursor-pointer self-start disabled:opacity-60"
            >
              {suggesting ? "Reading your course…" : "Suggest topics"}
            </button>
          </section>
        )}

        {notice ? (
          <p role="status" className="m-0 rounded-lg bg-rail px-3.5 py-3 text-[12.5px] text-ink2">
            {notice}
          </p>
        ) : null}

        <TopicMap
          examId={exam.id}
          topics={topics}
          progress={progress}
          onChange={setTopics}
          onPractice={(topicId) => setMode({ kind: "practice", topicId })}
        />

        <div className="border-t border-line pt-6">
          <ExamFiles examId={exam.id} files={files} marks={marks} onChange={setMarks} />
        </div>
      </div>
    </div>
  );
}
