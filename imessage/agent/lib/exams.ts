// Exam reminders and the exam facts Polya texts from. Pure: no I/O and no clock reads, so the
// timing rules are testable (test/exams.test.ts). exams-db.ts loads the rows, exams-runner.ts
// runs the pass inside the check-in loop, and the agent writes the actual text
// (instructions/check-ins.md, "[polya exam]").
//
// Students add exams in Study on the Polya website. An exam with a date gets up to four texts,
// each decided in the student's own time zone and outside their quiet hours:
//   exam_week  4 to 7 days out, from 10 AM: offer a plan
//   exam_soon  2 to 3 days out, from 10 AM: weakest topics, offer a quiz by text
//   exam_eve   the day before, from 5 PM: review topics and a last-minute list
//   exam_day   the morning of, before noon: what to remember
// At most one exam text per student per local day, most urgent exam first. Each text is claimed
// in polya_imessage_reminders under exam:<exam id>:<exam date>, so moving the exam starts over.
// Until the database accepts these kinds (20261021071045_polya_imessage_exam_reminders.sql) a
// claim throws ExamKindUnavailableError and the pass sends nothing.
import { inQuietHours, resolveTimeZone, type CheckInLink } from "./check-ins.ts";
import type { MasteryStage } from "./study-progress.ts";

export type ExamReminderKind = "exam_week" | "exam_soon" | "exam_eve" | "exam_day";

/** Thrown by a claim when the database doesn't accept exam kinds yet (its check constraint, 23514). */
export class ExamKindUnavailableError extends Error {
  constructor() {
    super("The database doesn't accept exam reminders yet");
    this.name = "ExamKindUnavailableError";
  }
}

export const EXAM_RULES = {
  weekMinDays: 4,
  weekMaxDays: 7,
  soonMinDays: 2,
  soonMaxDays: 3,
  /** exam_week and exam_soon wait until this local hour. */
  daytimeFromHour: 10,
  /** exam_eve goes out from this local hour on the day before. */
  eveFromHour: 17,
  /** exam_day goes out only before this local hour, so it never lands after the exam. */
  morningBeforeHour: 12,
  maxPerLocalDay: 1,
  topicsShown: 8,
  formulasShown: 6,
  mistakesShown: 3,
  planItemsShown: 4,
} as const;

export const EXAM_PREFIX = "[polya exam]";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FIELD_LENGTH = 160;
const EXAM_KEY = /^exam:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$/i;

const KIND_LABEL: Readonly<Record<ExamReminderKind, string>> = {
  exam_week: "exam coming up",
  exam_soon: "exam in a few days",
  exam_eve: "exam tomorrow",
  exam_day: "exam today",
};

export const STAGE_WORDS: Readonly<Record<MasteryStage, string>> = {
  not_started: "not started",
  learning: "learning",
  practicing: "practicing",
  exam_ready: "exam-ready",
  needs_review: "needs review",
};

/** Weakest first: slipping topics, then untouched ones, then by how far along they are. */
const STAGE_ORDER: Readonly<Record<MasteryStage, number>> = {
  needs_review: 0,
  not_started: 1,
  learning: 2,
  practicing: 3,
  exam_ready: 4,
};

/** One upcoming exam, reduced to what selection needs. */
export interface ExamCandidate {
  readonly examId: string;
  /** YYYY-MM-DD, the date the student entered in Study. */
  readonly examDate: string;
}

/** A row of polya_imessage_reminders. */
export interface SentReminder {
  readonly itemKey: string;
  readonly kind: string;
  readonly sentAt: string;
}

export interface PlannedExamReminder {
  readonly examId: string;
  readonly examDate: string;
  readonly kind: ExamReminderKind;
  readonly itemKey: string;
}

export function examItemKey(examId: string, examDate: string): string {
  return `exam:${examId}:${examDate}`;
}

export function isExamItemKey(value: string): boolean {
  return EXAM_KEY.test(value);
}

/** Calendar days from the student's local today to the exam date (0 = today), or null for a bad date. */
export function daysUntilExam(examDate: string, now: Date, timezone: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(examDate)) return null;
  const exam = Date.parse(`${examDate}T00:00:00Z`);
  const today = Date.parse(`${localDate(now, resolveTimeZone(timezone))}T00:00:00Z`);
  if (!Number.isFinite(exam) || !Number.isFinite(today)) return null;
  return Math.round((exam - today) / DAY_MS);
}

/** The milestone an exam is at right now, or null when no exam text is due for it. */
export function classifyExam(examDate: string, now: Date, timezone: string): ExamReminderKind | null {
  const zone = resolveTimeZone(timezone);
  const days = daysUntilExam(examDate, now, zone);
  if (days === null) return null;
  const hour = localHour(now, zone);
  if (days === 0) return hour < EXAM_RULES.morningBeforeHour ? "exam_day" : null;
  if (days === 1) return hour >= EXAM_RULES.eveFromHour ? "exam_eve" : null;
  if (hour < EXAM_RULES.daytimeFromHour) return null;
  if (days >= EXAM_RULES.soonMinDays && days <= EXAM_RULES.soonMaxDays) return "exam_soon";
  if (days >= EXAM_RULES.weekMinDays && days <= EXAM_RULES.weekMaxDays) return "exam_week";
  return null;
}

/**
 * The exam text to send this student now, or null. `sent` is the student's reminder rows: every
 * row for these exams' keys plus everything from the last 26 hours (check-ins-db.ts
 * loadReminderSends), so both the dedupe and the daily cap see what they need.
 */
export function selectExamReminder(input: {
  readonly link: CheckInLink;
  readonly exams: readonly ExamCandidate[];
  readonly sent: readonly SentReminder[];
  readonly now: Date;
}): PlannedExamReminder | null {
  const { link, exams, sent, now } = input;
  if (!link.checkInsEnabled || !link.threadId || !Number.isFinite(now.getTime())) return null;
  if (inQuietHours(link, now)) return null;
  const zone = resolveTimeZone(link.timezone);
  const today = localDate(now, zone);

  const examSends = sent.filter((row) => isExamItemKey(row.itemKey));
  const sentToday = examSends.filter((row) => {
    const at = new Date(row.sentAt);
    return Number.isFinite(at.getTime()) && localDate(at, zone) === today;
  }).length;
  if (sentToday >= EXAM_RULES.maxPerLocalDay) return null;

  const done = new Set(examSends.map((row) => `${row.itemKey}|${row.kind}`));
  const due = exams
    .map((exam) => ({
      exam,
      kind: classifyExam(exam.examDate, now, zone),
      days: daysUntilExam(exam.examDate, now, zone) ?? Number.POSITIVE_INFINITY,
      itemKey: examItemKey(exam.examId, exam.examDate),
    }))
    .filter((c): c is typeof c & { kind: ExamReminderKind } => c.kind !== null && !done.has(`${c.itemKey}|${c.kind}`))
    .sort((a, b) => a.days - b.days || a.exam.examId.localeCompare(b.exam.examId));
  const first = due[0];
  if (!first) return null;
  return { examId: first.exam.examId, examDate: first.exam.examDate, kind: first.kind, itemKey: first.itemKey };
}

// ---------------------------------------------------------------------------
// Exam facts: what a hand-off and the exam_prep tool tell the agent.
// ---------------------------------------------------------------------------

export interface ExamTopicFacts {
  readonly title: string;
  readonly stage: MasteryStage;
  /** Mean score over the topic's recent attempts, 0-1; null before any. */
  readonly accuracy: number | null;
  readonly keyFormulas: readonly string[];
}

export interface ExamMistakeFacts {
  readonly topic: string | null;
  readonly what: string;
  readonly fix: string;
}

export interface ExamFacts {
  readonly examId: string;
  readonly title: string;
  readonly courseName: string | null;
  readonly examDate: string;
  /** Weakest first (orderTopics). */
  readonly topics: readonly ExamTopicFacts[];
  /** Open mistakes from the coach's log, newest first. */
  readonly mistakes: readonly ExamMistakeFacts[];
  /** Today's unfinished items from the coach's study plan. */
  readonly todayPlan: readonly string[];
  readonly mocksHandedIn: number;
  /** Best handed-in mock score, 0-1; null when none. */
  readonly bestMockScore: number | null;
}

/** Topics weakest first: by stage (STAGE_ORDER), then lower recent accuracy, then exam order. */
export function orderTopics<T extends ExamTopicFacts & { readonly position: number }>(topics: readonly T[]): T[] {
  return [...topics].sort(
    (a, b) =>
      STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] ||
      (a.accuracy ?? 0) - (b.accuracy ?? 0) ||
      a.position - b.position,
  );
}

/** "today (Wed, Oct 21)", "tomorrow (Thu, Oct 22)", or "Mon, Oct 26". */
export function describeExamDate(examDate: string, now: Date, timezone: string): string {
  const days = daysUntilExam(examDate, now, timezone);
  const parsed = Date.parse(`${examDate}T12:00:00Z`);
  if (days === null || !Number.isFinite(parsed)) return examDate;
  const label = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(parsed),
  );
  if (days === 0) return `today (${label})`;
  if (days === 1) return `tomorrow (${label})`;
  return label;
}

/** The facts as the exam_prep tool returns them: plain values, stage words, no internals beyond the id. */
export function examFactsView(facts: ExamFacts, now: Date, timezone: string) {
  return {
    exam_id: facts.examId,
    exam: cleanText(facts.title),
    course: facts.courseName ? cleanText(facts.courseName) : null,
    date: describeExamDate(facts.examDate, now, timezone),
    days_left: daysUntilExam(facts.examDate, now, timezone),
    topics_weakest_first: facts.topics.slice(0, EXAM_RULES.topicsShown).map((topic) => ({
      topic: cleanText(topic.title),
      stage: STAGE_WORDS[topic.stage],
      recent_accuracy: topic.accuracy === null ? null : `${Math.round(topic.accuracy * 100)}%`,
    })),
    key_formulas: keyFormulas(facts),
    open_mistakes: facts.mistakes.slice(0, EXAM_RULES.mistakesShown).map((m) => ({
      topic: m.topic ? cleanText(m.topic) : null,
      what: cleanText(m.what),
      fix: cleanText(m.fix),
    })),
    todays_plan: facts.todayPlan.slice(0, EXAM_RULES.planItemsShown).map(cleanText),
    mock_exams: mockLine(facts),
  };
}

/**
 * The hand-off message: the prefix line, then plain facts. What's included follows the kind:
 * the plan for the early texts, mistakes from exam_soon on, and key formulas only for the
 * evening before and the morning of. Topic titles, formulas, mistakes, and plan items come from
 * the student and from Polya's own writing, so each is flattened to one line and capped.
 */
export function formatExamHandOff(kind: ExamReminderKind, facts: ExamFacts, now: Date, timezone: string): string {
  const lines = [`type: ${KIND_LABEL[kind]}`, `exam: ${cleanText(facts.title) || "Exam"}`];
  if (facts.courseName) lines.push(`course: ${cleanText(facts.courseName)}`);
  lines.push(`date: ${describeExamDate(facts.examDate, now, timezone)}`);
  const days = daysUntilExam(facts.examDate, now, timezone);
  if (days !== null) lines.push(`days left: ${days}`);

  const topics = facts.topics.slice(0, EXAM_RULES.topicsShown);
  if (topics.length > 0) {
    lines.push("topics, weakest first:");
    for (const topic of topics) {
      const accuracy = topic.accuracy === null ? "" : `, ${Math.round(topic.accuracy * 100)}% on recent questions`;
      lines.push(`- ${cleanText(topic.title)}: ${STAGE_WORDS[topic.stage]}${accuracy}`);
    }
  } else {
    lines.push("topics: none yet");
  }

  if (kind === "exam_eve" || kind === "exam_day") {
    const formulas = keyFormulas(facts);
    if (formulas.length > 0) lines.push("key formulas:", ...formulas.map((f) => `- ${f}`));
  }
  if (kind !== "exam_week") {
    const mistakes = facts.mistakes.slice(0, EXAM_RULES.mistakesShown);
    if (mistakes.length > 0) {
      lines.push("open mistakes:");
      for (const m of mistakes) lines.push(`- what: ${cleanText(m.what)} | fix: ${cleanText(m.fix)}`);
    }
  }
  if (kind === "exam_week" || kind === "exam_soon") {
    const plan = facts.todayPlan.slice(0, EXAM_RULES.planItemsShown);
    lines.push(plan.length > 0 ? "today's plan:" : "study plan: none for today");
    for (const item of plan) lines.push(`- ${cleanText(item)}`);
  }
  lines.push(`mock exams: ${mockLine(facts)}`);
  lines.push(`exam_id: ${facts.examId}`);
  return [EXAM_PREFIX, lines.join("\n")].join("\n\n");
}

/** Key formulas from the weakest topics first, deduplicated and capped. */
function keyFormulas(facts: ExamFacts): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const topic of facts.topics) {
    for (const formula of topic.keyFormulas) {
      const clean = cleanText(formula);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
      if (out.length >= EXAM_RULES.formulasShown) return out;
    }
  }
  return out;
}

function mockLine(facts: ExamFacts): string {
  if (facts.mocksHandedIn === 0 || facts.bestMockScore === null) return "none handed in yet";
  return `${facts.mocksHandedIn} handed in, best ${Math.round(facts.bestMockScore * 100)}%`;
}

/** YYYY-MM-DD of an instant in a time zone. */
export function localDate(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function localHour(instant: Date, timezone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" })
    .formatToParts(instant)
    .find((part) => part.type === "hour")?.value;
  return Number(hour ?? 0) % 24;
}

function cleanText(value: string): string {
  const flat = value.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").replace(/\s+/gu, " ").trim();
  return flat.length > MAX_FIELD_LENGTH ? `${flat.slice(0, MAX_FIELD_LENGTH - 1).trimEnd()}…` : flat;
}
