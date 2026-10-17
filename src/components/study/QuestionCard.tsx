"use client";

import Link from "next/link";
import { useId, useState } from "react";

import MathText from "@/components/MathText";
import MessageBubble from "@/components/chat/MessageBubble";
import PartField from "@/components/study/PartField";
import { AI_BUSY_POLYA_STUDY } from "@/lib/ai-busy";
import { FunctionError, invokeFunction } from "@/lib/functions";
import { userMessage } from "@/lib/user-message";
import {
  draftsFromResponses,
  partsReady,
  responsesFromDrafts,
  scoreLabel,
  type Draft,
  type GradedAttempt,
  type PartResponse,
  type QuestionRow,
} from "@/lib/study";

interface Props {
  courseId: string;
  question: Pick<QuestionRow, "id" | "stem" | "parts">;
  /** Set once graded; the card then shows results instead of inputs. */
  graded: GradedAttempt | null;
  onGraded: (graded: GradedAttempt, responses: PartResponse[]) => void;
  onCite: (n: number) => void;
  onReported: () => void;
  /** What was submitted, for a card shown again after a reload. */
  initialResponses?: PartResponse[] | null;
  /** Show the "Talk it through with Polya" link (off inside the exam coach, which already talks it through). */
  talkThrough?: boolean;
  /** Fold the worked solution away until it's opened. */
  explanationCollapsed?: boolean;
}

export default function QuestionCard({
  courseId,
  question,
  graded,
  onGraded,
  onCite,
  onReported,
  initialResponses,
  talkThrough = true,
  explanationCollapsed = false,
}: Props) {
  const name = useId();
  const [drafts, setDrafts] = useState<Draft[]>(() => draftsFromResponses(question.parts, initialResponses));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reportNote, setReportNote] = useState("");
  const [reported, setReported] = useState(false);

  const update = (i: number, patch: Partial<Draft>) =>
    setDrafts((current) => current.map((draft, j) => (j === i ? { ...draft, ...patch } : draft)));

  const ready = partsReady(question.parts, drafts);
  const hasWritten = question.parts.some((part) => part.kind === "free_response");

  async function submit() {
    setSubmitting(true);
    setError(null);
    const responses = responsesFromDrafts(question.parts, drafts);
    try {
      const result = await invokeFunction<GradedAttempt>("polya-study", {
        action: "submit_attempt",
        question_id: question.id,
        responses,
      });
      onGraded(result, responses);
    } catch (err) {
      // An unreadable answer ("bad_answer") records nothing; its message says why.
      setError(
        err instanceof FunctionError && err.code === "bad_answer"
          ? err.message
          : err instanceof FunctionError && err.code === "busy"
          ? AI_BUSY_POLYA_STUDY
          : userMessage(err),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function report() {
    try {
      await invokeFunction("polya-study", { action: "flag_question", question_id: question.id, note: reportNote });
      setReported(true);
      setReporting(false);
      onReported();
    } catch (err) {
      setError(userMessage(err));
    }
  }

  const explanation = graded ? (
    <MessageBubble
      message={{ role: "assistant", content: graded.explanation, sources: graded.sources }}
      messageIndex={0}
      onCiteClick={(_, n) => onCite(n)}
    />
  ) : null;

  return (
    <article className="flex flex-col gap-5">
      <div className="text-[14.5px] leading-[1.75] whitespace-pre-line text-ink">
        <MathText text={question.stem} />
      </div>

      {question.parts.map((part, i) => (
        <PartField
          key={i}
          part={part}
          index={i}
          count={question.parts.length}
          name={`${name}-p${i}`}
          draft={drafts[i]!}
          onChange={(patch) => update(i, patch)}
          disabled={submitting}
          result={graded?.results[i] ?? null}
          partKey={graded?.answers[i] ?? null}
        />
      ))}

      {error ? (
        <p role="alert" className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber">
          {error}
        </p>
      ) : null}

      {!graded ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!ready || submitting}
            className="button-primary h-9 cursor-pointer disabled:cursor-default disabled:opacity-50"
          >
            {submitting ? (hasWritten ? "Reading your work…" : "Checking…") : "Check my answer"}
          </button>
          {!ready ? <span className="text-[12px] text-ink3">Answer every part first.</span> : null}
        </div>
      ) : (
        <section className="flex flex-col gap-3 border-t border-line pt-5">
          <p role="status" className="m-0 text-[12.5px] font-semibold text-ink2">
            {scoreLabel(question.parts, graded.results)}
          </p>
          {explanationCollapsed ? (
            <details className="flex flex-col gap-3">
              <summary className="cursor-pointer text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">
                Worked solution
              </summary>
              <div className="pt-3">{explanation}</div>
            </details>
          ) : (
            <>
              <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">Worked solution</span>
              {explanation}
            </>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
            {talkThrough ? (
              <Link
                href={`/app/courses/${courseId}?practice=${question.id}`}
                className="text-[12.5px] font-semibold text-accent-ink hover:underline"
              >
                Talk it through with Polya →
              </Link>
            ) : null}
            {reported ? (
              <span className="text-[12px] text-ink3">Thanks. This question won&apos;t come up again.</span>
            ) : (
              <button
                type="button"
                onClick={() => setReporting((open) => !open)}
                className="cursor-pointer text-[12px] text-ink3 underline hover:text-ink"
              >
                Report a problem with this question
              </button>
            )}
          </div>
          {reporting ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={reportNote}
                onChange={(e) => setReportNote(e.target.value)}
                rows={2}
                maxLength={1000}
                placeholder="What's wrong? (optional) For example, the answer looks off, or it's not on the exam"
                className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-[9px] text-[12.5px] outline-none placeholder:text-ink3 focus:border-accent"
              />
              <button type="button" onClick={() => void report()} className="button-secondary h-8 cursor-pointer self-start text-[12.5px]">
                Send report
              </button>
            </div>
          ) : null}
        </section>
      )}
    </article>
  );
}
