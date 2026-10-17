"use client";

import { useState } from "react";

import MathText, { MathSpan } from "@/components/MathText";
import RichText from "@/components/chat/RichText";
import { formatValue, type Draft, type PublicPart } from "@/lib/study";
import { evalExpression, expressionToLatex } from "../../../supabase/functions/_shared/study-expr.ts";
import type { PartKey, PartResult } from "../../../supabase/functions/_shared/study-grade.ts";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

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

/** "Right" / "Partly there" / "Not quite" for a graded part. */
function verdict(result: PartResult): { label: string; good: boolean } | null {
  if (!result.ok) return null;
  if (typeof result.points === "number") {
    const awarded = result.awarded ?? 0;
    if (awarded === result.points) return { label: `Right · ${awarded}/${result.points}`, good: true };
    return { label: `${awarded > 0 ? "Partly there" : "Not quite"} · ${awarded}/${result.points}`, good: false };
  }
  return result.correct ? { label: "Right", good: true } : { label: "Not quite", good: false };
}

interface Props {
  part: PublicPart;
  index: number;
  /** How many parts the question has; (a), (b)… labels show when more than one. */
  count: number;
  /** Unique per rendered card (useId), so two cards' radio groups never merge. */
  name: string;
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  disabled: boolean;
  /** Set once graded: the card shows results instead of inputs. */
  result?: PartResult | null;
  partKey?: PartKey | null;
}

// One part of a practice question: its prompt, the answer input for its kind,
// and once graded, whether it was right and what the key was.
export default function PartField({ part, index, count, name, draft, onChange, disabled, result, partKey }: Props) {
  const [preview, setPreview] = useState(false);
  const graded = Boolean(result);
  const mark = result ? verdict(result) : null;
  const label = count > 1 ? `part ${String.fromCharCode(97 + index)}` : "";

  return (
    <section className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-surface px-4 py-3.5 shadow-card">
      <div className="flex items-start gap-2.5">
        {count > 1 ? (
          <span className="mt-[3px] shrink-0 font-mono text-[11px] text-ink3">({String.fromCharCode(97 + index)})</span>
        ) : null}
        <div className="min-w-0 flex-1 text-[13.5px] leading-[1.7] whitespace-pre-line">
          <MathText text={part.prompt} />
          {part.kind === "free_response" && !graded ? (
            <span className="ml-1.5 text-[11.5px] text-ink3">({part.points} points)</span>
          ) : null}
        </div>
        {mark ? (
          <span
            className={`shrink-0 rounded px-2 py-[3px] text-[10px] font-[650] uppercase tracking-[0.07em] ${
              mark.good ? "bg-accent-soft text-accent-ink" : "bg-amber-soft text-amber"
            }`}
          >
            {mark.label}
          </span>
        ) : null}
      </div>

      {part.kind === "numeric" ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <input
              value={draft.numeric}
              onChange={(e) => onChange({ numeric: e.target.value })}
              disabled={disabled || graded}
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              aria-label={`Answer${label ? ` to ${label}` : ""}`}
              placeholder="A number or an expression, like C(10,3)*0.5^10"
              className="w-full max-w-[340px] rounded-lg border border-line bg-surface px-3 py-[7px] font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-ink3 focus:border-accent disabled:bg-rail"
            />
            {graded ? null : <NumericPreview text={draft.numeric} />}
          </div>
          {partKey?.kind === "numeric" ? (
            <p className="m-0 text-[12.5px] text-ink2">
              Answer: {keyLatex(partKey) ? <MathSpan tex={keyLatex(partKey)!} /> : null}{" "}
              <span className="font-mono text-ink3">≈ {formatValue(partKey.value)}</span>
            </p>
          ) : null}
        </div>
      ) : part.kind === "free_response" ? (
        <div className="flex flex-col gap-2">
          {preview && !graded ? (
            <div className="min-h-[96px] rounded-lg border border-line-soft bg-rail px-3 py-2.5 text-[13px] leading-[1.7]">
              <RichText text={draft.text || "Nothing written yet."} />
            </div>
          ) : (
            <textarea
              value={draft.text}
              onChange={(e) => onChange({ text: e.target.value })}
              disabled={disabled || graded}
              rows={5}
              maxLength={3000}
              aria-label={`Written answer${label ? ` to ${label}` : ""}`}
              placeholder="Write out your reasoning. Polya reads the whole thing, not just the last line."
              className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-[9px] text-[13px] leading-[1.6] outline-none placeholder:text-ink3 focus:border-accent disabled:bg-rail"
            />
          )}
          {!graded ? (
            <div className="flex items-center gap-3 text-[11.5px] text-ink3">
              <button
                type="button"
                onClick={() => setPreview((on) => !on)}
                aria-pressed={preview}
                className="cursor-pointer underline hover:text-ink"
              >
                {preview ? "Edit" : "Preview math"}
              </button>
              <span>{draft.text.length.toLocaleString("en-US")} / 3,000</span>
            </div>
          ) : null}
          {result?.ok && result.feedback ? (
            <div className="rounded-lg bg-rail px-3 py-2.5 text-[13px] leading-[1.7] text-ink2">
              <RichText text={result.feedback} />
              {result.misconception ? (
                <p className="m-0 mt-1.5 text-[12.5px] text-ink2">
                  <span className="font-semibold text-ink">Where it went off track:</span> {result.misconception}
                </p>
              ) : null}
            </div>
          ) : null}
          {partKey?.kind === "free_response" ? (
            <details className="rounded-lg border border-line-soft px-3 py-2 text-[13px]">
              <summary className="cursor-pointer text-[12.5px] font-semibold text-ink2">A full-marks answer</summary>
              <div className="mt-2 leading-[1.7]">
                <RichText text={partKey.model_answer} />
              </div>
            </details>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5" role={part.kind === "mc" ? "radiogroup" : "group"} aria-label={label || undefined}>
          {part.options.map((option, j) => {
            const chosen = part.kind === "mc" ? draft.mc === j : draft.select.includes(j);
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
                className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-[13px] leading-[1.6] ${tone} ${
                  graded ? "cursor-default" : "cursor-pointer"
                }`}
              >
                <input
                  type={part.kind === "mc" ? "radio" : "checkbox"}
                  name={name}
                  checked={chosen}
                  disabled={disabled || graded}
                  onChange={() =>
                    part.kind === "mc"
                      ? onChange({ mc: j })
                      : onChange({ select: chosen ? draft.select.filter((k) => k !== j) : [...draft.select, j] })
                  }
                  className="mt-[5px] accent-[var(--accent)]"
                />
                <span className="mt-[3px] shrink-0 font-mono text-[11px] text-ink3">{LETTERS[j]}</span>
                <span className="min-w-0 flex-1">
                  <MathText text={option} />
                </span>
                {graded && isKey ? <span className="shrink-0 text-[11px] font-semibold text-accent-ink">Correct</span> : null}
                {graded && chosen && !isKey ? <span className="shrink-0 text-[11px] font-semibold text-amber">Your pick</span> : null}
              </label>
            );
          })}
          {part.kind === "select_all" && !graded ? (
            <span className="text-[11.5px] text-ink3">Select all that apply, possibly none.</span>
          ) : null}
        </div>
      )}
    </section>
  );
}
