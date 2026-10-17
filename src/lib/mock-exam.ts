// Timed mock exams in the browser: the clock (from the server's due time,
// corrected for this device's clock), the answers kept on this device while
// the student works, and plain-language advice for the report.
// Pure and dependency-free so `tests/` can import it under Node's test runner.

import { emptyDraft, partsReady, type Draft, type PartResponse, type PublicPart } from "./study.ts";
import type { TutorSource } from "./sse.ts";
import type { PartKey, PartResult } from "../../supabase/functions/_shared/study-grade.ts";
import type { MockReport } from "../../supabase/functions/_shared/study-mock.ts";

export interface MockQuestion {
  id: string;
  stem: string;
  parts: PublicPart[];
}

/** What's kept on this device while a mock is in progress. */
export interface MockDraft {
  answers: Record<string, Draft[]>;
  flagged: string[];
  /** Index of the question on screen. */
  current: number;
}

const FIVE_MINUTES = 5 * 60_000;
const ONE_MINUTE = 60_000;
const MAX_NUMERIC_CHARS = 300;
const MAX_TEXT_CHARS = 3_000;

export function mockDraftKey(userId: string, mockId: string): string {
  return `polya:mock:${userId}:${mockId}`;
}

/**
 * Milliseconds left until `dueAt`. `skewMs` is the server's clock minus this
 * device's (captured when the clock started), so a fast or slow device clock
 * doesn't give or take time.
 */
export function remainingMs(dueAt: string, skewMs: number, now: number): number {
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return 0;
  return Math.max(0, due - (now + skewMs));
}

/** "4:05", or "1:02:09" past an hour. Rounds up so 0:00 means time's up. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

/** The warning to announce when the clock passes 5 minutes or 1 minute left (the more urgent one if both). */
export function warningCrossed(prevMs: number, ms: number): "5 minutes left" | "1 minute left" | null {
  if (ms <= 0) return null;
  if (prevMs > ONE_MINUTE && ms <= ONE_MINUTE) return "1 minute left";
  if (prevMs > FIVE_MINUTES && ms <= FIVE_MINUTES) return "5 minutes left";
  return null;
}

export function emptyMockDraft(questions: readonly MockQuestion[]): MockDraft {
  return {
    answers: Object.fromEntries(questions.map((q) => [q.id, q.parts.map(() => emptyDraft())])),
    flagged: [],
    current: 0,
  };
}

function draftsFor(draft: MockDraft, question: MockQuestion): Draft[] {
  return draft.answers[question.id] ?? question.parts.map(() => emptyDraft());
}

/** Whether nothing at all has been entered for a question (an untouched select-all counts as blank). */
export function isBlank(question: MockQuestion, draft: MockDraft): boolean {
  return draftsFor(draft, question).every(
    (d) => d.numeric.trim() === "" && d.mc === null && d.select.length === 0 && d.text.trim() === "",
  );
}

/** Whether every part of a question has an answer. */
export function isAnswered(question: MockQuestion, draft: MockDraft): boolean {
  return !isBlank(question, draft) && partsReady(question.parts, draftsFor(draft, question));
}

export function answeredCount(questions: readonly MockQuestion[], draft: MockDraft): number {
  return questions.filter((q) => isAnswered(q, draft)).length;
}

/** "You've left 2 questions blank." (and how many are half done), or null when everything is answered. */
export function unfinishedNotice(questions: readonly MockQuestion[], draft: MockDraft): string | null {
  const blank = questions.filter((q) => isBlank(q, draft)).length;
  const partial = questions.filter((q) => !isBlank(q, draft) && !isAnswered(q, draft)).length;
  if (blank === 0 && partial === 0) return null;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (partial === 0) return `You've left ${plural(blank, "question")} blank.`;
  if (blank === 0) return `You've left ${plural(partial, "question")} unfinished.`;
  return `You've left ${plural(blank, "question")} blank and ${partial} unfinished.`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readDraft(raw: unknown, part: PublicPart): Draft {
  const draft = emptyDraft();
  if (!isObject(raw)) return draft;
  if (part.kind === "numeric" && typeof raw.numeric === "string") draft.numeric = raw.numeric.slice(0, MAX_NUMERIC_CHARS);
  if (part.kind === "free_response" && typeof raw.text === "string") draft.text = raw.text.slice(0, MAX_TEXT_CHARS);
  if (part.kind === "mc" && Number.isInteger(raw.mc) && (raw.mc as number) >= 0 && (raw.mc as number) < part.options.length) {
    draft.mc = raw.mc as number;
  }
  if (part.kind === "select_all" && Array.isArray(raw.select)) {
    draft.select = [
      ...new Set(raw.select.filter((c): c is number => Number.isInteger(c) && c >= 0 && c < part.options.length)),
    ];
  }
  return draft;
}

/**
 * Answers saved on this device, checked against the mock's questions: corrupt
 * or stale data falls back to empty, choices outside a question's options are
 * dropped.
 */
export function parseMockDraft(raw: string | null, questions: readonly MockQuestion[]): MockDraft {
  const empty = emptyMockDraft(questions);
  if (!raw) return empty;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isObject(value)) return empty;
  const answers = isObject(value.answers) ? value.answers : {};
  const ids = new Set(questions.map((q) => q.id));
  const current = Number.isInteger(value.current) ? (value.current as number) : 0;
  return {
    answers: Object.fromEntries(
      questions.map((q) => {
        const saved = answers[q.id];
        return [q.id, q.parts.map((part, i) => readDraft(Array.isArray(saved) ? saved[i] : null, part))];
      }),
    ),
    flagged: Array.isArray(value.flagged)
      ? [...new Set(value.flagged.filter((id): id is string => typeof id === "string" && ids.has(id)))]
      : [],
    current: Math.max(0, Math.min(questions.length - 1, current)),
  };
}

/** A short next step for a topic in the report, from its score (0..1). */
export function topicAdvice(fraction: number): string {
  if (fraction >= 0.85) return "Solid. Keep it warm with mixed review.";
  if (fraction >= 0.6) return "Close. A few more exam-level questions.";
  if (fraction >= 0.3) return "Shaky. Revisit the method, then practice.";
  return "Start here. Relearn it before the exam.";
}

/** 7.75 → "7.75", 8 → "8", 7.5 → "7.5". */
export function formatPoints(value: number): string {
  return String(Math.round(value * 100) / 100);
}

// ---------------------------------------------------------------------------
// The review of a handed-in mock (polya-study submit_mock, or the page's own
// load of a mock handed in earlier).
// ---------------------------------------------------------------------------
export interface ReviewQuestion {
  id: string;
  topic_id: string;
  topic_ids: string[] | null;
  stem: string;
  parts: PublicPart[];
  sources: TutorSource[];
  attempt: {
    id: string;
    question_id: string;
    responses: PartResponse[];
    results: PartResult[];
    score: number;
    all_correct: boolean;
  } | null;
  key: { question_id: string; answers: PartKey[]; explanation: string } | null;
}

export type { MockReport };

export interface MockReview {
  report: MockReport;
  questions: ReviewQuestion[];
}

/** Whole minutes since `startedAt` (never negative). */
export function minutesSince(startedAt: string, now: number): number {
  const started = Date.parse(startedAt);
  return Number.isNaN(started) ? 0 : Math.max(0, Math.floor((now - started) / 60_000));
}
