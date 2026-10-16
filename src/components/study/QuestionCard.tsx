"use client";

import Link from "next/link";
import { useState } from "react";

import MathText, { MathSpan } from "@/components/MathText";
import MessageBubble from "@/components/chat/MessageBubble";
import { FunctionError, invokeFunction } from "@/lib/functions";
import { userMessage } from "@/lib/user-message";
import { formatValue, type GradedAttempt, type PartResponse, type QuestionRow } from "@/lib/study";
import { evalExpression, expressionToLatex } from "../../../supabase/functions/_shared/study-expr.ts";
import type { PartKey, PartResult } from "../../../supabase/functions/_shared/study-grade.ts";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

type Draft = { numeric: string; mc: number | null; select: number[] };

interface Props {
  courseId: string;
  question: QuestionRow;
  /** Set once graded; the card then shows results instead of inputs. */
  graded: GradedAttempt | null;
  onGraded: (graded: GradedAttempt, responses: PartResponse[]) => void;
  onCite: (n: number) => void;
  onReported: () => void;
}

function NumericPreview({ text }: { text: string }) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const result = evalExpression(trimmed);
  if (!result.ok) return <span className="text-[11.5px] text-ink3">{result.error}</span>;
  // A plain number needs no echo; an expression shows what it works out to.
  if (/^-?\d*\.?\d+(e-?\d+)?$/i.test(trimmed)) return null;
  return <span className="font-mono text-[11.5px] text-ink3">= {formatValue(result.value)}</span>;
}

function keyLatex(key: Extract<PartKey, { kind: "numeric" }>): string | null {
  const latex = expressionToLatex(key.expr);
  return latex.ok ? latex.latex : null;
}

export default function QuestionCard({ courseId, question, graded, onGraded, onCite, onReported }: Props) {
  const [drafts, setDrafts] = useState<Draft[]>(() => question.parts.map(() => ({ numeric: "", mc: null, select: [] })));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<PartResponse[] | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reportNote, setReportNote] = useState("");
  const [reported, setReported] = useState(false);

  const update = (i: number, patch: Partial<Draft>) =>
    setDrafts((current) => current.map((draft, j) => (j === i ? { ...draft, ...patch } : draft)));

  const responses: PartResponse[] = question.parts.map((part, i) => {
    const draft = drafts[i]!;
    if (part.kind === "numeric") return { kind: "numeric", answer: draft.numeric };
    if (part.kind === "mc") return { kind: "mc", choice: draft.mc ?? -1 };
    return { kind: "select_all", choices: [...draft.select].sort((a, b) => a - b) };
  });
  const ready = question.parts.every((part, i) =>
    part.kind === "numeric" ? drafts[i]!.numeric.trim() !== "" : part.kind === "mc" ? drafts[i]!.mc !== null : true,
  );

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await invokeFunction<GradedAttempt>("polya-study", {
        action: "submit_attempt",
        question_id: question.id,
        responses,
      });
      setSubmitted(responses);
      onGraded(result, responses);
    } catch (err) {
      // An unreadable answer ("bad_answer") records nothing; its message says why.
      setError(err instanceof FunctionError && err.code === "bad_answer" ? err.message : userMessage(err));
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

  const result = (i: number): PartResult | null => graded?.results[i] ?? null;
  const key = (i: number): PartKey | null => graded?.answers[i] ?? null;

  return (
    <article className="flex flex-col gap-5">
      <div className="text-[14.5px] leading-[1.75] whitespace-pre-line text-ink">
        <MathText text={question.stem} />
      </div>

      {question.parts.map((part, i) => {
        const partResult = result(i);
        const partKey = key(i);
        const right = partResult?.ok ? partResult.correct : null;
        const name = `q-${question.id}-p${i}`;
        return (
          <section key={i} className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-surface px-4 py-3.5 shadow-card">
            <div className="flex items-start gap-2.5">
              {question.parts.length > 1 ? (
                <span className="mt-[3px] shrink-0 font-mono text-[11px] text-ink3">({String.fromCharCode(97 + i)})</span>
              ) : null}
              <div className="min-w-0 flex-1 text-[13.5px] leading-[1.7] whitespace-pre-line">
                <MathText text={part.prompt} />
              </div>
              {right !== null ? (
                <span
                  className={`shrink-0 rounded px-2 py-[3px] text-[10px] font-[650] uppercase tracking-[0.07em] ${
                    right ? "bg-accent-soft text-accent-ink" : "bg-amber-soft text-amber"
                  }`}
                >
                  {right ? "Right" : "Not quite"}
                </span>
              ) : null}
            </div>

            {part.kind === "numeric" ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <input
                    value={graded ? ((submitted?.[i] as { answer?: string } | undefined)?.answer ?? "") : drafts[i]!.numeric}
                    onChange={(e) => update(i, { numeric: e.target.value })}
                    disabled={graded !== null || submitting}
                    inputMode="text"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`Answer${question.parts.length > 1 ? ` to part ${String.fromCharCode(97 + i)}` : ""}`}
                    placeholder="A number or an expression, like C(10,3)*0.5^10"
                    className="w-full max-w-[340px] rounded-lg border border-line bg-surface px-3 py-[7px] font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-ink3 focus:border-accent disabled:bg-rail"
                  />
                  {graded ? null : <NumericPreview text={drafts[i]!.numeric} />}
                </div>
                {partKey?.kind === "numeric" ? (
                  <p className="m-0 text-[12.5px] text-ink2">
                    Answer:{" "}
                    {keyLatex(partKey) ? <MathSpan tex={keyLatex(partKey)!} /> : null}{" "}
                    <span className="font-mono text-ink3">≈ {formatValue(partKey.value)}</span>
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5" role={part.kind === "mc" ? "radiogroup" : "group"}>
                {part.options.map((option, j) => {
                  const chosen =
                    part.kind === "mc" ? drafts[i]!.mc === j : drafts[i]!.select.includes(j);
                  const isKey =
                    partKey?.kind === "mc" ? partKey.correct === j : partKey?.kind === "select_all" ? partKey.correct.includes(j) : false;
                  const tone = !graded
                    ? chosen
                      ? "border-accent bg-accent-soft"
                      : "border-line-soft hover:border-ink3"
                    : isKey
                    ? "border-accent bg-accent-soft"
                    : chosen
                    ? "border-amber bg-amber-soft"
                    : "border-line-soft opacity-70";
                  return (
                    <label
                      key={j}
                      className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-[13px] leading-[1.6] ${tone} ${
                        graded ? "cursor-default" : ""
                      }`}
                    >
                      <input
                        type={part.kind === "mc" ? "radio" : "checkbox"}
                        name={name}
                        checked={chosen}
                        disabled={graded !== null || submitting}
                        onChange={() =>
                          part.kind === "mc"
                            ? update(i, { mc: j })
                            : update(i, {
                                select: chosen ? drafts[i]!.select.filter((k) => k !== j) : [...drafts[i]!.select, j],
                              })
                        }
                        className="mt-[5px] accent-[var(--accent)]"
                      />
                      <span className="shrink-0 font-mono text-[11px] text-ink3 mt-[3px]">{LETTERS[j]}</span>
                      <span className="min-w-0 flex-1">
                        <MathText text={option} />
                      </span>
                      {graded && isKey ? <span className="shrink-0 text-[11px] font-semibold text-accent-ink">Correct</span> : null}
                      {graded && chosen && !isKey ? (
                        <span className="shrink-0 text-[11px] font-semibold text-amber">Your pick</span>
                      ) : null}
                    </label>
                  );
                })}
                {part.kind === "select_all" && !graded ? (
                  <span className="text-[11.5px] text-ink3">Select all that apply — possibly none.</span>
                ) : null}
              </div>
            )}
          </section>
        );
      })}

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
            {submitting ? "Checking…" : "Check my answer"}
          </button>
          {!ready ? <span className="text-[12px] text-ink3">Answer every part first.</span> : null}
        </div>
      ) : (
        <section className="flex flex-col gap-3 border-t border-line pt-5">
          <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">Worked solution</span>
          <MessageBubble
            message={{ role: "assistant", content: graded.explanation, sources: graded.sources }}
            messageIndex={0}
            onCiteClick={(_, n) => onCite(n)}
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
            <Link
              href={`/app/courses/${courseId}?practice=${question.id}`}
              className="text-[12.5px] font-semibold text-accent-ink hover:underline"
            >
              Talk it through with Polya →
            </Link>
            {reported ? (
              <span className="text-[12px] text-ink3">Thanks — this question won&apos;t come up again.</span>
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
                placeholder="What's wrong? (optional) — e.g. the answer looks off, or it's not on the exam"
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
