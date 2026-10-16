// Study tab: row shapes read under RLS, and the labels the UI shows for them.
// Pure and dependency-free so `tests/` can import it under Node's test runner.

import type { TopicStatus } from "../../supabase/functions/_shared/study-progress.ts";
import type { PublicPart } from "../../supabase/functions/_shared/study-questions.ts";
import type { PartKey, PartResponse, PartResult } from "../../supabase/functions/_shared/study-grade.ts";
import type { TutorSource } from "./sse.ts";

export interface ExamRow {
  id: string;
  course_id: string;
  title: string;
  exam_date: string | null;
  scope_note: string | null;
  examples_note: string | null;
}

export interface TopicRow {
  id: string;
  position: number;
  title: string;
  summary: string | null;
  key_formulas: string[];
  source_ids: string[];
  origin: "proposed" | "student";
}

export interface QuestionRow {
  id: string;
  topic_id: string;
  stem: string;
  parts: PublicPart[];
  sources: TutorSource[];
  status: string;
  created_at: string;
}

export interface AttemptRow {
  question_id: string;
  topic_id: string;
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
  results: PartResult[];
  score: number;
  all_correct: boolean;
  answers: PartKey[];
  explanation: string;
  sources: TutorSource[];
}

export type { PartResponse, PublicPart, TopicStatus };

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
