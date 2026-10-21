// COPY of polya/supabase/functions/_shared/study-progress.ts, byte for byte below this header.
// The iMessage agent is a separate deployable (Vercel Root Directory `imessage`), so it can't
// import from outside its own folder. test/study-progress.test.ts fails when the two drift:
// change both together.
// --- end of copy header ---
// Study: how each topic is going, and which question to practice next.
// Computed from rows the student can already read (topics, questions,
// attempts), so the browser and the server agree without a stored summary.
// Pure module: no runtime globals.

export type TopicStatus = "not_started" | "shaky" | "getting_there" | "solid";

/** How many of a topic's latest attempts decide its status. */
export const RECENT_ATTEMPTS = 6;
/** Solid needs at least this many recent first tries: right answers on retries don't prove it. */
export const MIN_FIRST_TRIES = 3;
/** A missed question comes back after this long — spaced, not immediate. */
export const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export interface ProgressTopic {
  id: string;
  position: number;
}

export interface ProgressQuestion {
  id: string;
  topic_id: string;
  status: string;
  created_at: string;
  /** "bank" (independently checked) or "coach" (written mid-conversation). Missing = bank. */
  origin?: string | null;
}

export interface ProgressAttempt {
  question_id: string;
  topic_id: string;
  /** Every topic a mixed question covered (topic_id is the first). */
  topic_ids?: readonly string[] | null;
  score: number;
  all_correct: boolean;
  created_at: string;
}

/** Every topic an attempt counts toward. */
export function attemptTopics(attempt: Pick<ProgressAttempt, "topic_id" | "topic_ids">): string[] {
  return [...new Set([attempt.topic_id, ...(attempt.topic_ids ?? [])])];
}

export interface TopicProgress {
  status: TopicStatus;
  /** Attempts in this topic, all time. */
  attempts: number;
  /** Mean score over the latest RECENT_ATTEMPTS attempts, 0–1; null before any. */
  accuracy: number | null;
  /** Recent first tries counted toward solid, at most RECENT_ATTEMPTS. */
  firstTries: number;
}

const byNewest = (a: { created_at: string }, b: { created_at: string }) =>
  Date.parse(b.created_at) - Date.parse(a.created_at);

const meanScore = (attempts: readonly ProgressAttempt[]) =>
  attempts.reduce((sum, attempt) => sum + attempt.score, 0) / attempts.length;

/**
 * Each question's earliest attempt, newest first. A question's first attempt
 * is the only one made before its answer was shown.
 */
function firstTriesOf(newestFirst: readonly ProgressAttempt[]): ProgressAttempt[] {
  const first = new Map<string, ProgressAttempt>();
  for (const attempt of [...newestFirst].reverse()) {
    if (!first.has(attempt.question_id)) first.set(attempt.question_id, attempt);
  }
  return [...first.values()].reverse();
}

/**
 * Misses always count; right answers count toward solid only on a first try.
 * A missed question that comes back right after its key was shown is good
 * practice, but solid also needs MIN_FIRST_TRIES recent first tries at 80%+.
 */
export function topicProgress(attempts: readonly ProgressAttempt[]): TopicProgress {
  if (attempts.length === 0) return { status: "not_started", attempts: 0, accuracy: null, firstTries: 0 };
  const newest = [...attempts].sort(byNewest);
  const recent = newest.slice(0, RECENT_ATTEMPTS);
  const accuracy = meanScore(recent);
  const firsts = firstTriesOf(newest).slice(0, RECENT_ATTEMPTS);
  const solid = accuracy >= 0.8 && firsts.length >= MIN_FIRST_TRIES && meanScore(firsts) >= 0.8;
  const status: TopicStatus = accuracy < 0.5 ? "shaky" : solid ? "solid" : "getting_there";
  return { status, attempts: attempts.length, accuracy, firstTries: firsts.length };
}

export function progressByTopic(
  topics: readonly ProgressTopic[],
  attempts: readonly ProgressAttempt[],
): Map<string, TopicProgress> {
  const grouped = new Map<string, ProgressAttempt[]>();
  for (const attempt of attempts) {
    for (const topicId of attemptTopics(attempt)) {
      const list = grouped.get(topicId) ?? [];
      list.push(attempt);
      grouped.set(topicId, list);
    }
  }
  return new Map(topics.map((topic) => [topic.id, topicProgress(grouped.get(topic.id) ?? [])]));
}

const STATUS_ORDER: Record<TopicStatus, number> = { shaky: 0, not_started: 1, getting_there: 2, solid: 3 };

/** Topics weakest first: shaky, then untouched, then getting there, then solid. */
export function weakestFirst(
  topics: readonly ProgressTopic[],
  progress: Map<string, TopicProgress>,
): ProgressTopic[] {
  return [...topics].sort((a, b) => {
    const pa = progress.get(a.id)!;
    const pb = progress.get(b.id)!;
    return (
      STATUS_ORDER[pa.status] - STATUS_ORDER[pb.status] ||
      (pa.accuracy ?? 0) - (pb.accuracy ?? 0) ||
      a.position - b.position
    );
  });
}

export type NextStep =
  | { kind: "question"; questionId: string; topicId: string }
  | { kind: "write"; topicId: string }
  | { kind: "none" };

/**
 * The next thing to practice. Within the chosen topics, weakest first:
 * an unanswered question, else a missed one whose last miss is at least
 * RETRY_AFTER_MS old. Only when none is left does it ask for new questions,
 * for the weakest topic — reusing what exists before writing more.
 *
 * `topicId` limits practice to one topic; otherwise every topic that isn't
 * solid is in play (all of them, once everything is solid). `skip` holds
 * questions already shown in this session.
 */
export function pickNext(input: {
  topics: readonly ProgressTopic[];
  questions: readonly ProgressQuestion[];
  attempts: readonly ProgressAttempt[];
  now: number;
  topicId?: string | null;
  skip?: ReadonlySet<string>;
}): NextStep {
  const { topics, questions, attempts, now, topicId, skip } = input;
  if (topics.length === 0) return { kind: "none" };
  const progress = progressByTopic(topics, attempts);

  let candidates: ProgressTopic[];
  if (topicId) {
    candidates = topics.filter((topic) => topic.id === topicId);
    if (candidates.length === 0) return { kind: "none" };
  } else {
    const ordered = weakestFirst(topics, progress);
    const notSolid = ordered.filter((topic) => progress.get(topic.id)!.status !== "solid");
    candidates = notSolid.length > 0 ? notSolid : ordered;
  }

  const lastAttempt = new Map<string, ProgressAttempt>();
  for (const attempt of [...attempts].sort(byNewest)) {
    if (!lastAttempt.has(attempt.question_id)) lastAttempt.set(attempt.question_id, attempt);
  }
  // Practice serves only independently checked questions; ones the coach wrote
  // mid-conversation stay in that conversation.
  const usable = questions.filter((q) => q.status === "active" && (q.origin ?? "bank") === "bank" && !skip?.has(q.id));

  for (const topic of candidates) {
    const inTopic = usable.filter((q) => q.topic_id === topic.id);
    const unanswered = inTopic
      .filter((q) => !lastAttempt.has(q.id))
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    if (unanswered.length > 0) return { kind: "question", questionId: unanswered[0]!.id, topicId: topic.id };

    const due = inTopic
      .map((q) => ({ q, last: lastAttempt.get(q.id) }))
      .filter(({ last }) => last && !last.all_correct && now - Date.parse(last.created_at) >= RETRY_AFTER_MS)
      .sort((a, b) => Date.parse(a.last!.created_at) - Date.parse(b.last!.created_at));
    if (due.length > 0) return { kind: "question", questionId: due[0]!.q.id, topicId: topic.id };
  }

  return { kind: "write", topicId: candidates[0]!.id };
}

// ---------------------------------------------------------------------------
// Mastery stages (the coach's tracker). The coach stores learning /
// practicing / exam_ready on a topic; "not started" and "needs review" are
// worked out here from the attempts, so they can't go stale.
// ---------------------------------------------------------------------------
export type StoredStage = "learning" | "practicing" | "exam_ready";
export type MasteryStage = "not_started" | StoredStage | "needs_review";

export const STORED_STAGES: readonly StoredStage[] = ["learning", "practicing", "exam_ready"];
export const MASTERY_STAGES: readonly MasteryStage[] = ["not_started", "learning", "practicing", "exam_ready", "needs_review"];

/** An exam-ready topic left alone this long needs a refresher. */
export const REVIEW_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export function isStoredStage(value: unknown): value is StoredStage {
  return value === "learning" || value === "practicing" || value === "exam_ready";
}

/** Exam-ready needs recent, consistent evidence: the same bar as "solid". */
export function canMarkExamReady(progress: TopicProgress): boolean {
  return progress.status === "solid";
}

export interface StageTopic extends ProgressTopic {
  stage?: string | null;
}

export interface TopicStageInfo {
  stage: MasteryStage;
  progress: TopicProgress;
  /** Newest attempt in this topic, if any. */
  lastAttemptAt: string | null;
}

export function effectiveStage(input: {
  stored: string | null | undefined;
  progress: TopicProgress;
  lastAttempt: { created_at: string; all_correct: boolean } | null;
  now: number;
}): MasteryStage {
  const { stored, progress, lastAttempt, now } = input;
  if (stored === "exam_ready") {
    if (!lastAttempt) return "exam_ready";
    if (!lastAttempt.all_correct) return "needs_review";
    if (now - Date.parse(lastAttempt.created_at) >= REVIEW_AFTER_MS) return "needs_review";
    return "exam_ready";
  }
  if (stored === "learning" || stored === "practicing") return stored;
  // Never staged by the coach: answered questions (e.g. from the drill) count
  // as practicing; nothing yet is not started.
  return progress.attempts > 0 ? "practicing" : "not_started";
}

export function stagesByTopic(
  topics: readonly StageTopic[],
  attempts: readonly ProgressAttempt[],
  now: number,
): Map<string, TopicStageInfo> {
  const progress = progressByTopic(topics, attempts);
  const latest = new Map<string, ProgressAttempt>();
  for (const attempt of [...attempts].sort(byNewest)) {
    for (const topicId of attemptTopics(attempt)) {
      if (!latest.has(topicId)) latest.set(topicId, attempt);
    }
  }
  return new Map(
    topics.map((topic) => {
      const p = progress.get(topic.id)!;
      const last = latest.get(topic.id) ?? null;
      return [
        topic.id,
        {
          stage: effectiveStage({ stored: topic.stage, progress: p, lastAttempt: last, now }),
          progress: p,
          lastAttemptAt: last?.created_at ?? null,
        },
      ];
    }),
  );
}

/**
 * What's due for spaced review: topics whose stage slipped to needs review,
 * and questions missed at least RETRY_AFTER_MS ago that haven't been answered
 * right since (oldest miss first).
 */
export function dueReviews(input: {
  topics: readonly StageTopic[];
  attempts: readonly ProgressAttempt[];
  now: number;
  limit?: number;
}): { topicIds: string[]; questionIds: string[] } {
  const { topics, attempts, now } = input;
  const limit = input.limit ?? 5;
  const stages = stagesByTopic(topics, attempts, now);
  const topicIds = topics.filter((t) => stages.get(t.id)?.stage === "needs_review").map((t) => t.id).slice(0, limit);

  const last = new Map<string, ProgressAttempt>();
  for (const attempt of [...attempts].sort(byNewest)) {
    if (!last.has(attempt.question_id)) last.set(attempt.question_id, attempt);
  }
  const questionIds = [...last.values()]
    .filter((a) => !a.all_correct && now - Date.parse(a.created_at) >= RETRY_AFTER_MS)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .map((a) => a.question_id)
    .slice(0, limit);
  return { topicIds, questionIds };
}

export interface StudyErrorRow {
  id: string;
  topic_id: string | null;
  created_at: string;
}

/**
 * Whether each logged mistake is fixed: a later, fully right answer on the
 * same topic. A mistake with no topic stays open until the student clears it.
 */
export function errorStatus<T extends StudyErrorRow>(
  errors: readonly T[],
  attempts: readonly ProgressAttempt[],
): (T & { fixed: boolean })[] {
  return errors.map((error) => {
    const at = Date.parse(error.created_at);
    const fixed = error.topic_id !== null &&
      attempts.some((a) => a.all_correct && Date.parse(a.created_at) > at && attemptTopics(a).includes(error.topic_id!));
    return { ...error, fixed };
  });
}
