"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import QuestionCard from "@/components/study/QuestionCard";
import SourcePanel from "@/components/viewer/SourcePanel";
import SourceSheet from "@/components/viewer/SourceSheet";
import { formatPoints, topicAdvice, type MockReview, type ReviewQuestion } from "@/lib/mock-exam";
import type { TutorSource } from "@/lib/sse";
import type { GradedAttempt } from "@/lib/study";
import { useMediaQuery, WIDE_LAYOUT_QUERY } from "@/lib/use-media-query";

interface Props {
  courseId: string;
  examId: string;
  mockId: string;
  title: string;
  minutes: number;
  review: MockReview;
  topics: { id: string; title: string }[];
}

function gradedFor(question: ReviewQuestion): GradedAttempt | null {
  if (!question.attempt || !question.key) return null;
  return {
    attempt_id: question.attempt.id,
    results: question.attempt.results,
    score: question.attempt.score,
    all_correct: question.attempt.all_correct,
    answers: question.key.answers,
    explanation: question.key.explanation,
    sources: question.sources ?? [],
  };
}

function outcome(question: ReviewQuestion): { label: string; good: boolean } {
  const attempt = question.attempt;
  if (!attempt) return { label: "Not graded", good: false };
  if (attempt.all_correct) return { label: "Right", good: true };
  return attempt.score > 0 ? { label: "Partly right", good: false } : { label: "Not quite", good: false };
}

// A handed-in mock: the score, how each topic went and what to do next, and
// every question with its worked solution. "Review with Polya" hands the
// report to the exam coach.
export default function MockReport({ courseId, examId, mockId, title, minutes, review, topics }: Props) {
  const { report } = review;
  const [viewing, setViewing] = useState<TutorSource | null>(null);
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY);
  const topicTitle = new Map(topics.map((t) => [t.id, t.title]));
  const examHref = `/app/courses/${courseId}/study/${examId}`;
  const closeViewer = useCallback(() => setViewing(null), []);
  const overtimeMinutes = Math.ceil(report.overtime_seconds / 60);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[720px] flex-col gap-7 px-5 pt-9 pb-14 sm:px-8">
          <header className="flex flex-col gap-2 border-b border-line pb-5">
            <p className="eyebrow m-0">Mock exam report</p>
            <h2 className="text-[21px]">{title}</h2>
            <p className="m-0 text-[28px] font-semibold tabular-nums tracking-[-0.02em]">
              {Math.round(report.score * 100)}%{" "}
              <span className="text-[15px] font-normal text-ink2">
                · {formatPoints(report.earned)} of {report.possible}
              </span>
            </p>
            <p className="m-0 text-[12.5px] text-ink3">
              Used {report.minutes_used} of {minutes} minutes
              {overtimeMinutes > 0 ? ` · handed in ${overtimeMinutes} minute${overtimeMinutes === 1 ? "" : "s"} late` : ""}
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              <Link href={`${examHref}?review=${mockId}`} className="button-primary h-9 px-4 text-[13px]">
                Review with Polya
              </Link>
              <Link href={examHref} className="button-secondary h-9 px-4 text-[13px]">
                Back to the exam
              </Link>
            </div>
          </header>

          {report.per_topic.length > 0 ? (
            <section className="flex flex-col gap-2.5">
              <h3 className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">By topic, weakest first</h3>
              <div role="region" aria-label="Score by topic" tabIndex={0} className="overflow-x-auto rounded-[9px] border border-line-soft">
                <table className="w-full border-collapse text-left text-[13px]">
                  <thead className="bg-rail text-[11.5px] text-ink3">
                    <tr>
                      <th scope="col" className="px-3.5 py-2 font-semibold">
                        Topic
                      </th>
                      <th scope="col" className="px-3.5 py-2 font-semibold">
                        Score
                      </th>
                      <th scope="col" className="px-3.5 py-2 font-semibold">
                        What next
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.per_topic.map((row) => {
                      const fraction = row.possible > 0 ? row.earned / row.possible : 0;
                      return (
                        <tr key={row.topic_id} className="border-t border-line-soft align-top">
                          <td className="px-3.5 py-2.5 font-medium">{row.title}</td>
                          <td className="px-3.5 py-2.5 whitespace-nowrap tabular-nums text-ink2">
                            {formatPoints(row.earned)}/{row.possible} · {Math.round(fraction * 100)}%
                          </td>
                          <td className="px-3.5 py-2.5 text-ink2">{topicAdvice(fraction)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section className="flex flex-col gap-2.5">
            <h3 className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">Every question</h3>
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {review.questions.map((question, i) => {
                const graded = gradedFor(question);
                const mark = outcome(question);
                const topicNames = [question.topic_id, ...(question.topic_ids ?? [])]
                  .filter((id, j, all) => all.indexOf(id) === j)
                  .map((id) => topicTitle.get(id))
                  .filter(Boolean)
                  .join(" + ");
                return (
                  <li key={question.id}>
                    <details className="rounded-[10px] border border-line bg-surface shadow-card">
                      <summary className="flex cursor-pointer items-center gap-3 px-4 py-3">
                        <span className="font-mono text-[12px] text-ink3">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink2">{topicNames || "Question"}</span>
                        <span
                          className={`shrink-0 rounded px-2 py-[3px] text-[10px] font-[650] uppercase tracking-[0.07em] ${
                            mark.good ? "bg-accent-soft text-accent-ink" : "bg-amber-soft text-amber"
                          }`}
                        >
                          {mark.label}
                        </span>
                      </summary>
                      <div className="border-t border-line-soft px-4 pt-4 pb-5">
                        {graded ? (
                          <QuestionCard
                            courseId={courseId}
                            question={question}
                            graded={graded}
                            initialResponses={question.attempt?.responses ?? null}
                            onGraded={() => undefined}
                            onCite={(n) => setViewing(question.sources?.find((s) => s.n === n) ?? null)}
                            onReported={() => undefined}
                            talkThrough={false}
                          />
                        ) : (
                          <p className="m-0 text-[12.5px] text-ink3">This question&apos;s result couldn&apos;t be loaded.</p>
                        )}
                      </div>
                    </details>
                  </li>
                );
              })}
            </ol>
          </section>
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
