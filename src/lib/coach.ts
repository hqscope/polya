// Exam coach: the conversation as the page holds it (stored rows → messages,
// streamed text and blocks → segments) and how the side rail follows along.
// Pure and dependency-free so `tests/` can import it under Node's test runner.

import {
  parseCoachBlock,
  parseEventMeta,
  parseSegments,
  type CoachBlock,
  type CoachSegment,
  type EventMeta,
  type StudyPlan,
} from "../../supabase/functions/_shared/coach-blocks.ts";
import type { PartKey, PartResponse, PartResult } from "../../supabase/functions/_shared/study-grade.ts";
import type { TutorSource } from "./sse.ts";
import type { GradedAttempt, MockRow, StudyErrorRow, TopicRow } from "./study.ts";

export type { CoachBlock, CoachSegment, EventMeta, StudyPlan };
export { parseCoachBlock };

export type CoachMessage =
  | { localId: string; kind: "user"; text: string }
  | { localId: string; kind: "event"; label: string }
  | { localId: string; kind: "assistant"; segments: CoachSegment[]; sources: TutorSource[]; streaming?: boolean };

export interface StoredMessage {
  id: string;
  role: string;
  content: string;
  sources: unknown;
  blocks: unknown;
  meta: unknown;
}

/** The small line a click leaves in the thread, or null for none (opening the coach). */
export function eventLabel(meta: EventMeta): string | null {
  switch (meta.kind) {
    case "open":
      return null;
    case "attempt":
      return meta.possible !== undefined
        ? `You answered a question · ${meta.earned} of ${meta.possible} points`
        : `You answered a question · ${meta.right} of ${meta.total} right`;
    case "mock_submitted":
      return `You handed in ${meta.title} · ${Math.round(meta.pct)}%`;
  }
}

export function toCoachMessages(rows: readonly StoredMessage[]): CoachMessage[] {
  const out: CoachMessage[] = [];
  for (const row of rows) {
    if (row.role === "assistant") {
      const segments = parseSegments(row.blocks) ?? (row.content ? [{ type: "text" as const, text: row.content }] : []);
      out.push({
        localId: row.id,
        kind: "assistant",
        segments,
        sources: Array.isArray(row.sources) ? (row.sources as TutorSource[]) : [],
      });
      continue;
    }
    const meta = parseEventMeta(row.meta);
    if (meta) {
      const label = eventLabel(meta);
      if (label) out.push({ localId: row.id, kind: "event", label });
      continue;
    }
    out.push({ localId: row.id, kind: "user", text: row.content });
  }
  return out;
}

export function appendDelta(segments: readonly CoachSegment[], text: string): CoachSegment[] {
  if (!text) return segments as CoachSegment[];
  const last = segments[segments.length - 1];
  if (last?.type === "text") return [...segments.slice(0, -1), { type: "text", text: last.text + text }];
  return [...segments, { type: "text", text }];
}

export function appendBlock(segments: readonly CoachSegment[], block: CoachBlock): CoachSegment[] {
  return [...segments, { type: "block", block }];
}

/** Quick replies offered at the end of the newest turn, if it's the last thing in the thread. */
export function latestReplies(messages: readonly CoachMessage[]): string[] {
  const last = messages[messages.length - 1];
  if (!last || last.kind !== "assistant" || last.streaming) return [];
  for (let i = last.segments.length - 1; i >= 0; i--) {
    const segment = last.segments[i]!;
    if (segment.type === "block" && segment.block.type === "replies") return segment.block.replies;
  }
  return [];
}

export function questionIdsIn(messages: readonly CoachMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.kind !== "assistant") continue;
    for (const segment of message.segments) {
      if (segment.type === "block" && segment.block.type === "question") ids.push(segment.block.question.id);
    }
  }
  return ids;
}

/** The id of the newest plan block in the thread (only that one is interactive). */
export function latestPlanKey(messages: readonly CoachMessage[]): string | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]!;
    if (message.kind !== "assistant") continue;
    for (let s = message.segments.length - 1; s >= 0; s--) {
      const segment = message.segments[s]!;
      if (segment.type === "block" && segment.block.type === "plan") return `${message.localId}:${s}`;
    }
  }
  return null;
}

export interface AttemptForCard {
  question_id: string;
  responses: PartResponse[];
  results: PartResult[];
  score: number;
  all_correct: boolean;
  created_at: string;
}

/** A graded card rebuilt from stored rows: the latest attempt plus the key it unlocked. */
export function gradedFromRows(
  attempts: readonly AttemptForCard[],
  keys: readonly { question_id: string; answers: PartKey[]; explanation: string }[],
  sourcesFor: (questionId: string) => TutorSource[],
): Map<string, { graded: GradedAttempt; responses: PartResponse[] }> {
  const keyBy = new Map(keys.map((k) => [k.question_id, k]));
  const latest = new Map<string, AttemptForCard>();
  for (const attempt of attempts) {
    const current = latest.get(attempt.question_id);
    if (!current || Date.parse(attempt.created_at) > Date.parse(current.created_at)) latest.set(attempt.question_id, attempt);
  }
  const out = new Map<string, { graded: GradedAttempt; responses: PartResponse[] }>();
  for (const [questionId, attempt] of latest) {
    const key = keyBy.get(questionId);
    if (!key) continue;
    out.set(questionId, {
      responses: attempt.responses,
      graded: {
        results: attempt.results,
        score: attempt.score,
        all_correct: attempt.all_correct,
        answers: key.answers,
        explanation: key.explanation,
        sources: sourcesFor(questionId),
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The rail: plan, topics (with stages), mistakes and mock exams, kept in step
// with what the coach just did.
// ---------------------------------------------------------------------------
export interface RailState {
  plan: StudyPlan | null;
  topics: TopicRow[];
  errors: StudyErrorRow[];
  mocks: MockRow[];
}

export function applyCoachBlock(state: RailState, block: CoachBlock): RailState {
  switch (block.type) {
    case "plan":
      return { ...state, plan: block.plan };
    case "stage":
      return {
        ...state,
        topics: state.topics.map((t) => (t.id === block.topic_id ? { ...t, stage: block.stage } : t)),
      };
    case "error_logged":
      return state.errors.some((e) => e.id === block.error.id)
        ? state
        : { ...state, errors: [block.error, ...state.errors] };
    case "mock":
      return state.mocks.some((m) => m.id === block.mock.id)
        ? state
        : {
          ...state,
          mocks: [
            {
              id: block.mock.id,
              title: block.mock.title,
              minutes: block.mock.minutes,
              status: "building",
              question_ids: [],
              started_at: null,
              due_at: null,
              submitted_at: null,
              score: null,
              created_at: new Date(0).toISOString(),
            },
            ...state.mocks,
          ],
        };
    default:
      return state;
  }
}

/** A plan with one item ticked or unticked. */
export function togglePlanItem(plan: StudyPlan, itemId: string, done: boolean): StudyPlan {
  return {
    ...plan,
    days: plan.days.map((day) => ({
      ...day,
      items: day.items.map((item) => (item.id === itemId ? { ...item, done } : item)),
    })),
  };
}

/** The student's calendar date, YYYY-MM-DD. */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
