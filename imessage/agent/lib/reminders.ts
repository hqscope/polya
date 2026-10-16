// Submission-aware reminders: the pure half (tests import it). reminders-db.ts does the I/O.
//
// A reminder item is one assignment the student has to turn in, merged from Canvas
// (polya_sources, origin canvas_assignment) and Gradescope (when the student connected it). When
// both list the same assignment, one item is kept and Gradescope's submission status wins.
// Items already submitted, marked done by the student, or snoozed are left out. The windows,
// quiet hours, caps and time zones stay in check-ins.ts (selectCheckIns): this module only
// decides what goes into it.
//
// Item keys: `canvas:<polya source id>` or `gs:<course_id>:<assignment_id>`. A merged item keeps
// its Canvas key as the primary key and remembers the Gradescope keys too, so a mark or a sent
// reminder recorded under either key still counts.
import type { CheckInAssignment, SentCheckIn } from "./check-ins.ts";
import { describeDue as describeLocalDue } from "./dates.ts";
import type { GsAssignment, GsAssignmentStatus } from "./gradescope/types.ts";

/** A polya_sources row with origin 'canvas_assignment', joined to its course. */
export interface CanvasAssignmentInput {
  readonly sourceId: string;
  readonly userId: string;
  readonly courseName: string | null;
  readonly courseCode: string | null;
  readonly title: string;
  /** ISO timestamp, or null when Canvas has no due date. */
  readonly dueAt: string | null;
}

export interface ReminderItem {
  /** The key reminders are claimed under: the Canvas key when Canvas has it. */
  readonly itemKey: string;
  /** Every key this assignment is known by, primary first. */
  readonly keys: readonly string[];
  readonly userId: string;
  readonly canvasSourceId: string | null;
  readonly courseName: string | null;
  readonly title: string;
  readonly dueAt: string | null;
  /** Gradescope's status, or null when Gradescope has no matching assignment (or isn't connected). */
  readonly gradescopeStatus: GsAssignmentStatus | null;
  readonly url: string | null;
}

export type MarkStatus = "done" | "snoozed";

/** A polya_imessage_assignment_marks row. */
export interface AssignmentMark {
  readonly itemKey: string;
  readonly status: MarkStatus;
  /** ISO timestamp; a snooze only holds while this is in the future. */
  readonly until: string | null;
}

/**
 * "reminders": the polya_imessage_reminders table exists; items are claimed by item key.
 * "legacy": it doesn't yet; only Canvas items are reminded, claimed in polya_imessage_check_ins
 * by source id, exactly as before the migration.
 */
export type ReminderMode = "reminders" | "legacy";

const HOUR_MS = 60 * 60 * 1000;
/** Canvas and Gradescope due dates further apart than this are never the same assignment. */
const MAX_DUE_GAP_MS = 72 * HOUR_MS;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ITEM_KEY = new RegExp(`^(canvas:${UUID}|gs:[^:\\s]{1,64}:[^:\\s]{1,64})$`, "i");

export function canvasItemKey(sourceId: string): string {
  return `canvas:${sourceId}`;
}

export function gradescopeItemKey(assignment: Pick<GsAssignment, "course_id" | "assignment_id">): string {
  return `gs:${assignment.course_id}:${assignment.assignment_id}`;
}

/** True for a well-formed item key (`canvas:<uuid>` or `gs:<course>:<assignment>`). */
export function isItemKey(value: string): boolean {
  return ITEM_KEY.test(value);
}

/**
 * One list of reminder items from a student's Canvas assignments and Gradescope assignments
 * (null when Gradescope isn't connected). Each Gradescope assignment joins the Canvas assignment
 * it matches best (same course, same title); the rest stand alone. A Canvas item that absorbed
 * several Gradescope parts ("Written", "Coding") counts as submitted only when all of them are.
 */
export function mergeAssignments(
  userId: string,
  canvas: readonly CanvasAssignmentInput[],
  gradescope: readonly GsAssignment[] | null,
): ReminderItem[] {
  const ownCanvas = canvas.filter((row) => row.userId === userId);
  const absorbed = new Map<number, GsAssignment[]>();
  const standalone: GsAssignment[] = [];

  for (const gs of gradescope ?? []) {
    let best = -1;
    let bestScore = 0;
    ownCanvas.forEach((row, index) => {
      const score = matchScore(row, gs);
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    });
    if (best < 0) standalone.push(gs);
    else absorbed.set(best, [...(absorbed.get(best) ?? []), gs]);
  }

  const items: ReminderItem[] = ownCanvas.map((row, index) => {
    const parts = absorbed.get(index) ?? [];
    const key = canvasItemKey(row.sourceId);
    return {
      itemKey: key,
      keys: [key, ...parts.map(gradescopeItemKey)],
      userId,
      canvasSourceId: row.sourceId,
      courseName: row.courseName || row.courseCode || null,
      title: row.title,
      dueAt: row.dueAt ?? parts.find((part) => part.due_at)?.due_at ?? null,
      gradescopeStatus: combineStatus(parts.map((part) => part.status)),
      url: parts[0]?.url ?? null,
    };
  });
  for (const gs of standalone) {
    const key = gradescopeItemKey(gs);
    items.push({
      itemKey: key,
      keys: [key],
      userId,
      canvasSourceId: null,
      courseName: gs.course_name || null,
      title: gs.title,
      dueAt: gs.due_at,
      gradescopeStatus: gs.status,
      url: gs.url || null,
    });
  }
  return items;
}

export function isSubmitted(status: GsAssignmentStatus | null): boolean {
  return status === "submitted" || status === "graded";
}

/** True when the student marked the item done, or snoozed it until a time still in the future. */
export function isMarkedAway(item: Pick<ReminderItem, "keys">, marks: readonly AssignmentMark[], now: Date): boolean {
  const keys = new Set(item.keys);
  return marks.some((mark) => {
    if (!keys.has(mark.itemKey)) return false;
    if (mark.status === "done") return true;
    const until = mark.until ? Date.parse(mark.until) : Number.NaN;
    return Number.isFinite(until) && until > now.getTime();
  });
}

/** The status fact the check-in hand-off carries for an item. */
export function statusFact(status: GsAssignmentStatus | null): string {
  switch (status) {
    case "not_submitted":
      return "not submitted on Gradescope";
    case "unknown":
      return "Gradescope status unknown";
    case "submitted":
      return "submitted on Gradescope";
    case "graded":
      return "graded on Gradescope";
    default:
      return "submission status unknown";
  }
}

export interface PrepareCheckInsInput {
  readonly userId: string;
  readonly mode: ReminderMode;
  readonly items: readonly ReminderItem[];
  readonly marks: readonly AssignmentMark[];
  /** Earlier sends. In "reminders" mode sourceId is an item key; in "legacy" mode a source id. */
  readonly sent: readonly SentCheckIn[];
  readonly now: Date;
}

/**
 * Turns reminder items into selectCheckIns input: drops submitted, done and snoozed items, keys
 * each assignment the way its mode claims it, and folds sends recorded under a merged item's
 * other keys onto its primary key so dedupe sees them.
 */
export function prepareCheckIns({ userId, mode, items, marks, sent, now }: PrepareCheckInsInput): {
  assignments: CheckInAssignment[];
  sent: SentCheckIn[];
} {
  const assignments: CheckInAssignment[] = [];
  const primaryOf = new Map<string, string>();
  for (const item of items) {
    if (item.userId !== userId) continue;
    for (const key of item.keys) if (!primaryOf.has(key)) primaryOf.set(key, item.itemKey);
    if (isSubmitted(item.gradescopeStatus) || isMarkedAway(item, marks, now)) continue;
    const sourceId = mode === "legacy" ? item.canvasSourceId : item.itemKey;
    if (!sourceId) continue;
    assignments.push({
      sourceId,
      userId,
      courseName: item.courseName,
      title: item.title,
      dueAt: item.dueAt,
      status: statusFact(item.gradescopeStatus),
      itemKey: item.itemKey,
    });
  }
  const folded =
    mode === "legacy"
      ? [...sent]
      : sent.map((row) => ({ ...row, sourceId: primaryOf.get(row.sourceId) ?? row.sourceId }));
  return { assignments, sent: folded };
}

/** One assignment as the tools hand it to the agent, with the due time in the student's zone. */
export function assignmentView(item: ReminderItem, marks: readonly AssignmentMark[], now: Date, timeZone: string) {
  return {
    item_key: item.itemKey,
    title: item.title,
    course: item.courseName ?? "Unknown course",
    due: item.dueAt ? describeLocalDue(new Date(item.dueAt), now, timeZone) : "no due date",
    submission: submissionLabel(item, marks),
  };
}

/** How a tool describes an item's submission state to the agent. */
export function submissionLabel(item: Pick<ReminderItem, "keys" | "gradescopeStatus">, marks: readonly AssignmentMark[]): string {
  const keys = new Set(item.keys);
  if (marks.some((mark) => keys.has(mark.itemKey) && mark.status === "done")) return "student said it's done";
  return statusFact(item.gradescopeStatus);
}

export type AssignmentPick<T> =
  | { readonly kind: "found"; readonly item: T }
  | { readonly kind: "ambiguous"; readonly items: readonly T[] }
  | { readonly kind: "none" };

/** The one assignment an item key (any of its keys) or the student's title words point to. */
export function pickAssignment<T extends Pick<ReminderItem, "keys" | "title" | "courseName">>(
  items: readonly T[],
  query: { readonly itemKey?: string | undefined; readonly title?: string | undefined },
): AssignmentPick<T> {
  const key = query.itemKey?.trim();
  if (key) {
    const item = items.find((candidate) => candidate.keys.includes(key));
    if (item) return { kind: "found", item };
  }
  const matches = query.title ? findByTitleWords(items, query.title) : [];
  if (matches.length === 1 && matches[0]) return { kind: "found", item: matches[0] };
  if (matches.length > 1) return { kind: "ambiguous", items: matches };
  return { kind: "none" };
}

/** Items whose title (and course) contain every word the student used, e.g. "hw 7" or "61a hw7". */
export function findByTitleWords<T extends Pick<ReminderItem, "title" | "courseName">>(items: readonly T[], words: string): T[] {
  const wanted = titleTokens(words);
  if (wanted.length === 0) return [];
  const matches = items.filter((item) => {
    const have = new Set([...titleTokens(item.title), ...titleTokens(item.courseName ?? "")]);
    return wanted.every((word) => have.has(word));
  });
  if (matches.length <= 1) return matches;
  // "hw 7" names "Homework 7" exactly even when "Homework 7 Coding" also matches.
  const exact = matches.filter((item) => sameSet(new Set(titleTokens(item.title)), new Set(wanted)));
  return exact.length === 1 ? exact : matches;
}

// ---------------------------------------------------------------------------
// Matching a Canvas assignment to a Gradescope assignment.
// ---------------------------------------------------------------------------

/** 0 when the two aren't the same assignment, else a similarity in (0, 1]. */
export function matchScore(canvas: CanvasAssignmentInput, gs: GsAssignment): number {
  if (!coursesMatch([canvas.courseName, canvas.courseCode], gs.course_name)) return 0;
  const a = canvas.dueAt ? Date.parse(canvas.dueAt) : Number.NaN;
  const b = gs.due_at ? Date.parse(gs.due_at) : Number.NaN;
  if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > MAX_DUE_GAP_MS) return 0;
  return titleScore(canvas.title, gs.title);
}

const TITLE_ALIASES: Readonly<Record<string, string>> = {
  hw: "homework",
  hws: "homework",
  hmwk: "homework",
  homeworks: "homework",
  pset: "problem set",
  ps: "problem set",
  proj: "project",
  disc: "discussion",
  mt: "midterm",
  asgn: "assignment",
  assn: "assignment",
};
const FILLER = new Set(["the", "a", "an", "of", "for", "and", "to", "on", "in"]);

/**
 * Lowercase words with abbreviations expanded and numbers unpadded: "HW 7", "Homework 7" and
 * "hw07" all become ["homework", "7"]. A number keeps its letter suffix ("7a"), so "Project 1a"
 * and "Project 1b" stay different.
 */
export function titleTokens(value: string): string[] {
  const text = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ");
  const tokens: string[] = [];
  for (const word of text.split(" ")) {
    if (!word) continue;
    if (/^\d/.test(word)) {
      tokens.push(word.replace(/^0+(?=\d)/, ""));
      continue;
    }
    for (const part of (TITLE_ALIASES[word] ?? word).split(" ")) {
      if (!FILLER.has(part)) tokens.push(part);
    }
  }
  return tokens;
}

/**
 * Titles match when they carry the same numbers and their words overlap: one's words contain
 * the other's ("HW 7: Recursion" and "Homework 7") or at least half are shared. "Homework 7
 * Written" and "Homework 7 Coding" don't match; neither do "Homework 7" and "Homework 17".
 */
export function titleScore(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  const numbersA = new Set(ta.filter(isNumberToken));
  const numbersB = new Set(tb.filter(isNumberToken));
  if (!sameSet(numbersA, numbersB)) return 0;
  const wordsA = new Set(ta.filter((token) => !isNumberToken(token)));
  const wordsB = new Set(tb.filter((token) => !isNumberToken(token)));
  if (wordsA.size === 0 || wordsB.size === 0) {
    return wordsA.size === wordsB.size && numbersA.size > 0 ? 1 : 0;
  }
  const shared = [...wordsA].filter((word) => wordsB.has(word)).length;
  if (shared === 0) return 0;
  const union = wordsA.size + wordsB.size - shared;
  const subset = shared === wordsA.size || shared === wordsB.size;
  if (!subset && shared / union < 0.5) return 0;
  return (shared + numbersA.size) / (union + numbersA.size);
}

const TERM_WORDS = new Set(["fall", "spring", "summer", "winter", "semester", "quarter", "term", "session"]);
const COURSE_FILLER = new Set(["and", "of", "the", "to", "in", "for", "lec", "lecture", "sec", "section"]);

interface CourseTokens {
  /** Course numbers such as "61a", "1a", "100" (no years, no zero-padded section numbers). */
  readonly numbers: ReadonlySet<string>;
  readonly words: readonly string[];
}

function courseTokens(value: string): CourseTokens {
  const text = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Term codes and years: "Fall 2026", "Fa26", "SP '26", "2026".
    .replace(/\b(fall|spring|summer|winter|fa|sp|su|wi)\s*'?\s*(?:19|20)?\d{2}\b/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ");
  const numbers = new Set<string>();
  const words: string[] = [];
  for (const token of text.split(" ")) {
    if (!token || TERM_WORDS.has(token) || COURSE_FILLER.has(token)) continue;
    if (/^\d/.test(token)) {
      if (/^[1-9]\d{0,3}[a-z]{0,2}$/.test(token)) numbers.add(token);
      continue;
    }
    words.push(token);
  }
  return { numbers, words };
}

/**
 * Fuzzy course match between a Canvas course (name and code) and a Gradescope course name.
 * With course numbers on both sides: a shared number ("61a") and a compatible subject ("CS",
 * "COMPSCI", "Computer Science"). Without: most of the words in common.
 */
export function coursesMatch(canvasNames: readonly (string | null)[], gsName: string): boolean {
  const a = courseTokens(canvasNames.filter(Boolean).join(" "));
  const b = courseTokens(gsName);
  if (a.numbers.size > 0 && b.numbers.size > 0) {
    if (![...a.numbers].some((number) => b.numbers.has(number))) return false;
    return a.words.length === 0 || b.words.length === 0 || subjectsMatch(a.words, b.words);
  }
  const wordsA = new Set(a.words);
  const wordsB = new Set(b.words);
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  const shared = [...wordsA].filter((word) => wordsB.has(word)).length;
  return shared / (wordsA.size + wordsB.size - shared) >= 0.5;
}

const SUBJECT_ALIASES: Readonly<Record<string, string>> = { compsci: "cs", comsci: "cs", cosc: "cs" };

/**
 * A shared word ("COMPSCI" counts as "CS"), a prefix ("bio" of "biology", "chem" of
 * "chemistry"), or initials of consecutive words ("cs" for "computer science", "mcb" for
 * "molecular and cell biology").
 */
function subjectsMatch(a: readonly string[], b: readonly string[]): boolean {
  const wordsA = a.map((word) => SUBJECT_ALIASES[word] ?? word);
  const wordsB = b.map((word) => SUBJECT_ALIASES[word] ?? word);
  if (wordsA.some((word) => word.length >= 2 && wordsB.includes(word))) return true;
  return abbreviates(wordsA, wordsB) || abbreviates(wordsB, wordsA);
}

function abbreviates(short: readonly string[], long: readonly string[]): boolean {
  return short.some((word) => {
    if (word.length < 2) return false;
    if (word.length >= 3 && long.some((other) => other.length > word.length && other.startsWith(word))) return true;
    return long.some((_, start) => long.slice(start, start + word.length).map((other) => other[0]).join("") === word);
  });
}

function combineStatus(statuses: readonly GsAssignmentStatus[]): GsAssignmentStatus | null {
  if (statuses.length === 0) return null;
  if (statuses.every((status) => status === "graded")) return "graded";
  if (statuses.every(isSubmitted)) return "submitted";
  if (statuses.includes("not_submitted")) return "not_submitted";
  return "unknown";
}

function isNumberToken(token: string): boolean {
  return /^\d/.test(token);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}
