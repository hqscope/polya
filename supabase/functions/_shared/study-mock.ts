// Study: timed mock exams. Which questions go into one (spread across topics
// by weight, never one the student has seen), and the report once it's
// handed in. Pure module: no runtime globals.
//
// Only "bank" questions qualify: each was solved a second time by a checker
// that never saw the key. A question already attempted would have a readable
// key (polya_practice_keys RLS), so it's never reused in a mock.

import { attemptTopics } from "./study-progress.ts";

export const MOCK_MIN_QUESTIONS = 3;
export const MOCK_MAX_QUESTIONS = 12;
export const MOCK_MIN_MINUTES = 10;
export const MOCK_MAX_MINUTES = 180;
export const MOCK_MAX_WEIGHT = 5;
/** A hand-in this soon after time runs out still counts as on time (network, the auto-submit itself). */
export const MOCK_GRACE_MS = 30_000;

export interface MockSpec {
  question_count: number;
  /** Topic id → weight 1..5. */
  topic_weights: Record<string, number>;
  free_response: boolean;
}

export type SpecResult = { ok: true; spec: MockSpec } | { ok: false; error: string };

export function validateMockSpec(raw: unknown, topicIds: readonly string[]): SpecResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "missing spec" };
  const r = raw as Record<string, unknown>;
  const count = r.question_count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < MOCK_MIN_QUESTIONS || count > MOCK_MAX_QUESTIONS) {
    return { ok: false, error: `question_count must be ${MOCK_MIN_QUESTIONS}-${MOCK_MAX_QUESTIONS}` };
  }
  const weights: Record<string, number> = {};
  const known = new Set(topicIds);
  if (typeof r.topic_weights === "object" && r.topic_weights !== null) {
    for (const [id, w] of Object.entries(r.topic_weights as Record<string, unknown>)) {
      if (!known.has(id)) return { ok: false, error: "unknown topic" };
      if (typeof w !== "number" || !Number.isInteger(w) || w < 1 || w > MOCK_MAX_WEIGHT) {
        return { ok: false, error: `weights must be 1-${MOCK_MAX_WEIGHT}` };
      }
      weights[id] = w;
    }
  }
  if (Object.keys(weights).length === 0) return { ok: false, error: "no topics" };
  return { ok: true, spec: { question_count: count, topic_weights: weights, free_response: r.free_response === true } };
}

/**
 * How many questions each topic gets: proportional to weight, largest
 * remainders first, ties to the heavier then earlier topic. A topic can round
 * to zero when there are more topics than questions.
 */
export function mockTargets(spec: MockSpec): Map<string, number> {
  const entries = Object.entries(spec.topic_weights);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  const exact = entries.map(([id, w], order) => ({ id, w, order, exact: (spec.question_count * w) / total }));
  const targets = new Map(exact.map((e) => [e.id, Math.floor(e.exact)]));
  let left = spec.question_count - [...targets.values()].reduce((a, b) => a + b, 0);
  const byRemainder = [...exact].sort(
    (a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || b.w - a.w || a.order - b.order,
  );
  for (const e of byRemainder) {
    if (left <= 0) break;
    targets.set(e.id, targets.get(e.id)! + 1);
    left--;
  }
  return targets;
}

export interface BankQuestion {
  id: string;
  topic_id: string;
  status: string;
  origin?: string | null;
  created_at: string;
  parts?: readonly { kind: string }[];
}

/**
 * The questions to add to a mock now, and what each topic still lacks. Never
 * a coach-written, flagged, attempted, reserved or already-included question.
 */
export function pickMockQuestions(input: {
  spec: MockSpec;
  have: readonly string[];
  bank: readonly BankQuestion[];
  attemptedIds: ReadonlySet<string>;
  reservedIds: ReadonlySet<string>;
}): { chosen: string[]; deficits: Map<string, number> } {
  const { spec, have, bank, attemptedIds, reservedIds } = input;
  const targets = mockTargets(spec);
  const byId = new Map(bank.map((q) => [q.id, q]));
  const count = new Map<string, number>();
  for (const id of have) {
    const topic = byId.get(id)?.topic_id;
    if (topic) count.set(topic, (count.get(topic) ?? 0) + 1);
  }
  const taken = new Set(have);
  const chosen: string[] = [];
  const deficits = new Map<string, number>();
  for (const [topicId, target] of targets) {
    let need = target - (count.get(topicId) ?? 0);
    if (need <= 0) continue;
    const pool = bank
      .filter((q) =>
        q.topic_id === topicId && q.status === "active" && (q.origin ?? "bank") === "bank" &&
        !attemptedIds.has(q.id) && !reservedIds.has(q.id) && !taken.has(q.id)
      )
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (const q of pool) {
      if (need <= 0) break;
      chosen.push(q.id);
      taken.add(q.id);
      need--;
    }
    if (need > 0) deficits.set(topicId, need);
  }
  return { chosen, deficits };
}

/** The topic most short of questions (ties: the heavier topic). */
export function biggestDeficit(deficits: ReadonlyMap<string, number>, spec: MockSpec): string | null {
  let best: string | null = null;
  for (const [id, need] of deficits) {
    if (
      best === null || need > deficits.get(best)! ||
      (need === deficits.get(best)! && (spec.topic_weights[id] ?? 0) > (spec.topic_weights[best] ?? 0))
    ) {
      best = id;
    }
  }
  return best;
}

export interface MockQuestionResult {
  question_id: string;
  topic_id: string;
  topic_ids?: readonly string[] | null;
  /** 0..1 credit for the question. */
  score: number;
  all_correct: boolean;
}

export interface MockReport {
  score: number; // 0..1
  earned: number; // sum of question scores
  possible: number; // number of questions
  per_topic: { topic_id: string; title: string; earned: number; possible: number }[];
  questions: { question_id: string; score: number; all_correct: boolean }[];
  missed: string[];
  minutes_used: number;
  overtime_seconds: number;
}

export function buildMockReport(input: {
  results: readonly MockQuestionResult[];
  topics: readonly { id: string; title: string }[];
  startedAt: string;
  dueAt: string;
  submittedAt: string;
}): MockReport {
  const { results, topics } = input;
  const earned = results.reduce((sum, r) => sum + r.score, 0);
  const possible = results.length;
  const perTopic = new Map<string, { earned: number; possible: number }>();
  for (const result of results) {
    for (const topicId of attemptTopics(result)) {
      const entry = perTopic.get(topicId) ?? { earned: 0, possible: 0 };
      entry.earned += result.score;
      entry.possible += 1;
      perTopic.set(topicId, entry);
    }
  }
  const title = new Map(topics.map((t) => [t.id, t.title]));
  const started = Date.parse(input.startedAt);
  const submitted = Date.parse(input.submittedAt);
  const due = Date.parse(input.dueAt);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    score: possible === 0 ? 0 : round2(earned / possible),
    earned: round2(earned),
    possible,
    per_topic: topics
      .filter((t) => perTopic.has(t.id))
      .map((t) => ({ topic_id: t.id, title: title.get(t.id)!, ...perTopic.get(t.id)! }))
      .map((row) => ({ ...row, earned: round2(row.earned) }))
      .sort((a, b) => a.earned / a.possible - b.earned / b.possible),
    questions: results.map((r) => ({ question_id: r.question_id, score: round2(r.score), all_correct: r.all_correct })),
    missed: results.filter((r) => !r.all_correct).map((r) => r.question_id),
    minutes_used: Math.max(0, Math.round((submitted - started) / 60_000)),
    overtime_seconds: Math.max(0, Math.round((submitted - due - MOCK_GRACE_MS) / 1000)),
  };
}
