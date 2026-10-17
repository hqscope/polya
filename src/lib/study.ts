// Study tab: row shapes read under RLS, and the labels the UI shows for them.
// Pure and dependency-free so `tests/` can import it under Node's test runner.

import type { MasteryStage, TopicStatus } from "../../supabase/functions/_shared/study-progress.ts";
import type { PublicPart } from "../../supabase/functions/_shared/study-questions.ts";
import type { PartKey, PartResponse, PartResult } from "../../supabase/functions/_shared/study-grade.ts";
import type { TutorSource } from "./sse.ts";
import type { StudyPlan } from "../../supabase/functions/_shared/coach-blocks.ts";

export interface ExamRow {
  id: string;
  course_id: string;
  title: string;
  exam_date: string | null;
  scope_note: string | null;
  examples_note: string | null;
  /** The coach's study plan (exam coach). */
  plan?: StudyPlan | null;
}

export interface TopicRow {
  id: string;
  position: number;
  title: string;
  summary: string | null;
  key_formulas: string[];
  source_ids: string[];
  origin: "proposed" | "student";
  /** Set by the exam coach: learning, practicing or exam_ready. */
  stage?: string | null;
}

export interface QuestionRow {
  id: string;
  topic_id: string;
  stem: string;
  parts: PublicPart[];
  sources: TutorSource[];
  status: string;
  created_at: string;
  /** "bank" (independently checked) or "coach" (written in a conversation). */
  origin?: string;
  topic_ids?: string[];
  hide_topic?: boolean;
}

export interface AttemptRow {
  id?: string;
  question_id: string;
  topic_id: string;
  topic_ids?: string[];
  score: number;
  all_correct: boolean;
  created_at: string;
}

export interface ExamFileMark {
  source_id: string;
  kind: "formula_sheet" | "past_exam";
}

export interface CourseFile {
  id: string;
  title: string;
  status: string;
}

/** What polya-study returns after grading. */
export interface GradedAttempt {
  attempt_id?: string | null;
  created_at?: string;
  /** Every topic the question covered (revealed after a mixed question). */
  topic_ids?: string[];
  results: PartResult[];
  score: number;
  all_correct: boolean;
  answers: PartKey[];
  explanation: string;
  sources: TutorSource[];
}

export type { MasteryStage, PartResponse, PublicPart, TopicStatus };

export interface StudyErrorRow {
  id: string;
  topic_id: string | null;
  question_id: string | null;
  what: string;
  why: string;
  fix: string;
  created_at: string;
}

export interface MockRow {
  id: string;
  title: string;
  minutes: number;
  status: "building" | "ready" | "in_progress" | "submitted";
  question_ids: string[];
  started_at: string | null;
  due_at: string | null;
  submitted_at: string | null;
  score: number | null;
  created_at: string;
}

export const STAGE_LABEL: Record<MasteryStage, string> = {
  not_started: "Not started",
  learning: "Learning",
  practicing: "Practicing",
  exam_ready: "Exam-ready",
  needs_review: "Needs review",
};

export const STAGE_HINT: Record<MasteryStage, string> = {
  not_started: "Not started yet",
  learning: "Learning: getting the ideas down",
  practicing: "Practicing: answering questions, still missing some",
  exam_ready: "Exam-ready: right on recent questions without help",
  needs_review: "Needs review: it's been a while, or recent answers slipped",
};

export const STAGE_CLASS: Record<MasteryStage, string> = {
  not_started: "bg-line-soft text-ink3",
  learning: "bg-accent-soft text-accent-ink",
  practicing: "bg-accent-soft text-accent-ink",
  exam_ready: "bg-accent text-on-accent",
  needs_review: "bg-amber-soft text-amber",
};

/** Where each stage sits on the four-step ladder; needs review sits beside it. */
export const STAGE_STEP: Record<MasteryStage, number> = {
  not_started: 0,
  learning: 1,
  practicing: 2,
  exam_ready: 3,
  needs_review: 3,
};

// ---------------------------------------------------------------------------
// Answer drafts (a question card and the mock exam runner share these).
// ---------------------------------------------------------------------------
export interface Draft {
  numeric: string;
  mc: number | null;
  select: number[];
  text: string;
}

export const emptyDraft = (): Draft => ({ numeric: "", mc: null, select: [], text: "" });

export function responsesFromDrafts(parts: readonly PublicPart[], drafts: readonly Draft[]): PartResponse[] {
  return parts.map((part, i) => {
    const draft = drafts[i] ?? emptyDraft();
    switch (part.kind) {
      case "numeric":
        return { kind: "numeric", answer: draft.numeric };
      case "mc":
        return { kind: "mc", choice: draft.mc ?? -1 };
      case "select_all":
        return { kind: "select_all", choices: [...draft.select].sort((a, b) => a - b) };
      case "free_response":
        return { kind: "free_response", text: draft.text };
    }
  });
}

/** Every part answered (select-all may be left empty: "none of these" is an answer). */
export function partsReady(parts: readonly PublicPart[], drafts: readonly Draft[]): boolean {
  return parts.every((part, i) => {
    const draft = drafts[i] ?? emptyDraft();
    if (part.kind === "numeric") return draft.numeric.trim() !== "";
    if (part.kind === "mc") return draft.mc !== null;
    if (part.kind === "free_response") return draft.text.trim() !== "";
    return true;
  });
}

/** Drafts that show what was submitted (a resumed or reviewed card). */
export function draftsFromResponses(parts: readonly PublicPart[], responses: readonly PartResponse[] | null | undefined): Draft[] {
  return parts.map((_, i) => {
    const response = responses?.[i];
    const draft = emptyDraft();
    if (!response) return draft;
    if (response.kind === "numeric") draft.numeric = response.answer;
    else if (response.kind === "mc") draft.mc = response.choice >= 0 ? response.choice : null;
    else if (response.kind === "select_all") draft.select = [...response.choices];
    else draft.text = response.text;
    return draft;
  });
}

/** "2 of 3 right", or "5 of 7 points" when there was a written part. */
export function scoreLabel(parts: readonly PublicPart[], results: readonly PartResult[]): string {
  if (parts.some((p) => p.kind === "free_response")) {
    let earned = 0;
    let possible = 0;
    parts.forEach((part, i) => {
      const result = results[i];
      const max = part.kind === "free_response" ? part.points : 1;
      possible += max;
      if (result?.ok) earned += typeof result.awarded === "number" ? result.awarded : result.correct ? 1 : 0;
    });
    return `${earned} of ${possible} points`;
  }
  const right = results.filter((r) => r.ok && r.correct).length;
  return `${right} of ${parts.length} right`;
}

export const TOPIC_STATUS_LABEL: Record<TopicStatus, string> = {
  not_started: "Not started",
  shaky: "Needs work",
  getting_there: "Getting there",
  solid: "Solid",
};

export const TOPIC_STATUS_CLASS: Record<TopicStatus, string> = {
  not_started: "bg-line-soft text-ink3",
  shaky: "bg-amber-soft text-amber",
  getting_there: "bg-accent-soft text-accent-ink",
  solid: "bg-accent text-on-accent",
};

export const FILE_KIND_LABEL: Record<ExamFileMark["kind"], string> = {
  formula_sheet: "Formula sheet",
  past_exam: "Past exam",
};

/** "Today", "Tomorrow", "In 12 days", "3 days ago" — or null without a date. */
export function examDateLabel(examDate: string | null, now: Date = new Date()): string | null {
  if (!examDate) return null;
  const [y, m, d] = examDate.split("-").map(Number);
  if (!y || !m || !d) return null;
  const exam = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((exam - today) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return days > 0 ? `In ${days} days` : `${-days} days ago`;
}

/** A computed value shown next to an answer: 4 significant figures, no noise. */
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (value !== 0 && (Math.abs(value) < 1e-4 || Math.abs(value) >= 1e7)) return value.toExponential(3);
  return String(Number(value.toPrecision(4)));
}
