// Study: how each topic is going, and which question to practice next.
// Computed from rows the student can already read (topics, questions,
// attempts), so the browser and the server agree without a stored summary.
// Pure module: no runtime globals.

export type TopicStatus = "not_started" | "shaky" | "getting_there" | "solid";

/** How many of a topic's latest attempts decide its status. */
export const RECENT_ATTEMPTS = 6;
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
}

export interface ProgressAttempt {
  question_id: string;
  topic_id: string;
  score: number;
  all_correct: boolean;
  created_at: string;
}

export interface TopicProgress {
  status: TopicStatus;
  /** Attempts in this topic, all time. */
  attempts: number;
  /** Mean score over the latest RECENT_ATTEMPTS attempts, 0–1; null before any. */
  accuracy: number | null;
}

const byNewest = (a: { created_at: string }, b: { created_at: string }) =>
  Date.parse(b.created_at) - Date.parse(a.created_at);

export function topicProgress(attempts: readonly ProgressAttempt[]): TopicProgress {
  if (attempts.length === 0) return { status: "not_started", attempts: 0, accuracy: null };
  const recent = [...attempts].sort(byNewest).slice(0, RECENT_ATTEMPTS);
  const accuracy = recent.reduce((sum, attempt) => sum + attempt.score, 0) / recent.length;
  const status: TopicStatus =
    accuracy < 0.5 ? "shaky" : accuracy >= 0.8 && recent.length >= 3 ? "solid" : "getting_there";
  return { status, attempts: attempts.length, accuracy };
}

export function progressByTopic(
  topics: readonly ProgressTopic[],
  attempts: readonly ProgressAttempt[],
): Map<string, TopicProgress> {
  const grouped = new Map<string, ProgressAttempt[]>();
  for (const attempt of attempts) {
    const list = grouped.get(attempt.topic_id) ?? [];
    list.push(attempt);
    grouped.set(attempt.topic_id, list);
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
  const usable = questions.filter((q) => q.status === "active" && !skip?.has(q.id));

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
