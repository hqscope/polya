// The exam coach's interactive pieces: what polya-coach streams and stores
// alongside its text (a practice question, the study plan, a stage change, a
// logged mistake, the course inventory, quick replies, a mock exam), and how
// the browser reads them back. Shared by the edge function and the app so both
// validate the same shapes.
//
// Nothing here ever carries an answer key or a worked explanation: message
// rows are readable by the student, and keys stay in polya_practice_keys until
// an attempt exists.
//
// Pure module: no runtime globals.

import type { Inventory } from "./study-inventory.ts";
import type { PublicPart } from "./study-questions.ts";
import type { StoredStage } from "./study-progress.ts";

export interface CoachQuestion {
  id: string;
  stem: string;
  parts: PublicPart[];
  /** 1 warm-up, 2 standard, 3 exam-hard. */
  difficulty: 1 | 2 | 3 | null;
  /** Mixed practice: the topics stay unnamed until the question is answered. */
  hide_topic: boolean;
  /** Omitted while hidden. */
  topic_ids?: string[];
}

export interface PlanItem {
  id: string;
  topic_id: string | null;
  text: string;
  done: boolean;
}

export interface PlanDay {
  /** YYYY-MM-DD */
  date: string;
  focus: string;
  items: PlanItem[];
}

export interface StudyPlan {
  days: PlanDay[];
  note: string;
}

export interface LoggedError {
  id: string;
  topic_id: string | null;
  question_id: string | null;
  what: string;
  why: string;
  fix: string;
  created_at: string;
}

export interface MockSummary {
  id: string;
  title: string;
  minutes: number;
  question_count: number;
}

export type CoachBlock =
  | { type: "question"; question: CoachQuestion }
  | { type: "stage"; topic_id: string; title: string; stage: StoredStage; note: string }
  | { type: "error_logged"; error: LoggedError }
  | { type: "plan"; plan: StudyPlan; updated_at: string }
  | { type: "inventory"; inventory: Inventory }
  | { type: "replies"; replies: string[] }
  | { type: "mock"; mock: MockSummary };

export type CoachSegment = { type: "text"; text: string } | { type: "block"; block: CoachBlock };

/** Stored on a student row that a click sent rather than typed. */
export type EventMeta =
  | { kind: "open" }
  | {
    kind: "attempt";
    attempt_id: string;
    question_id: string;
    /** Parts fully right, of all parts. */
    right: number;
    total: number;
    /** Set when the question had a written part: points earned of possible. */
    earned?: number;
    possible?: number;
  }
  | { kind: "mock_submitted"; mock_id: string; title: string; pct: number };

// ---------------------------------------------------------------------------
// Reading blocks back (from SSE events and stored rows). Anything off-shape
// is dropped rather than rendered.
// ---------------------------------------------------------------------------
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const cap = (value: string, max: number) => (value.length <= max ? value : value.slice(0, max));

function asPart(value: unknown): PublicPart | null {
  if (!isObject(value) || !isString(value.prompt)) return null;
  switch (value.kind) {
    case "numeric":
      return { kind: "numeric", prompt: value.prompt };
    case "mc":
    case "select_all":
      return isStringArray(value.options) ? { kind: value.kind, prompt: value.prompt, options: value.options } : null;
    case "free_response":
      return typeof value.points === "number" ? { kind: "free_response", prompt: value.prompt, points: value.points } : null;
    default:
      return null;
  }
}

function asQuestion(value: unknown): CoachQuestion | null {
  if (!isObject(value) || !isString(value.id) || !isString(value.stem) || !Array.isArray(value.parts)) return null;
  const parts = value.parts.map(asPart);
  if (parts.length === 0 || parts.some((p) => p === null)) return null;
  const difficulty = value.difficulty === 1 || value.difficulty === 2 || value.difficulty === 3 ? value.difficulty : null;
  const question: CoachQuestion = {
    id: value.id,
    stem: value.stem,
    parts: parts as PublicPart[],
    difficulty,
    hide_topic: value.hide_topic === true,
  };
  if (isStringArray(value.topic_ids)) question.topic_ids = value.topic_ids;
  return question;
}

export function asPlan(value: unknown): StudyPlan | null {
  if (!isObject(value) || !Array.isArray(value.days)) return null;
  const days: PlanDay[] = [];
  for (const day of value.days) {
    if (!isObject(day) || !isString(day.date) || !isString(day.focus) || !Array.isArray(day.items)) return null;
    const items: PlanItem[] = [];
    for (const item of day.items) {
      if (!isObject(item) || !isString(item.id) || !isString(item.text)) return null;
      items.push({
        id: item.id,
        topic_id: isString(item.topic_id) ? item.topic_id : null,
        text: cap(item.text, 300),
        done: item.done === true,
      });
    }
    days.push({ date: day.date, focus: cap(day.focus, 200), items });
  }
  return { days, note: isString(value.note) ? cap(value.note, 600) : "" };
}

function asError(value: unknown): LoggedError | null {
  if (!isObject(value) || !isString(value.id) || !isString(value.what)) return null;
  return {
    id: value.id,
    topic_id: isString(value.topic_id) ? value.topic_id : null,
    question_id: isString(value.question_id) ? value.question_id : null,
    what: cap(value.what, 300),
    why: isString(value.why) ? cap(value.why, 600) : "",
    fix: isString(value.fix) ? cap(value.fix, 600) : "",
    created_at: isString(value.created_at) ? value.created_at : "",
  };
}

function asInventory(value: unknown): Inventory | null {
  if (!isObject(value) || !Array.isArray(value.tiles) || !Array.isArray(value.groups)) return null;
  if (typeof value.readable !== "number" || !Array.isArray(value.exams_without_solutions)) return null;
  // The server built it from rows; a shallow check is enough to render safely.
  return value as unknown as Inventory;
}

export function parseCoachBlock(value: unknown): CoachBlock | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case "question": {
      const question = asQuestion(value.question);
      return question ? { type: "question", question } : null;
    }
    case "stage":
      if (!isString(value.topic_id) || !isString(value.title)) return null;
      if (value.stage !== "learning" && value.stage !== "practicing" && value.stage !== "exam_ready") return null;
      return {
        type: "stage",
        topic_id: value.topic_id,
        title: value.title,
        stage: value.stage,
        note: isString(value.note) ? cap(value.note, 500) : "",
      };
    case "error_logged": {
      const error = asError(value.error);
      return error ? { type: "error_logged", error } : null;
    }
    case "plan": {
      const plan = asPlan(value.plan);
      return plan ? { type: "plan", plan, updated_at: isString(value.updated_at) ? value.updated_at : "" } : null;
    }
    case "inventory": {
      const inventory = asInventory(value.inventory);
      return inventory ? { type: "inventory", inventory } : null;
    }
    case "replies":
      return isStringArray(value.replies)
        ? { type: "replies", replies: value.replies.slice(0, 4).map((r) => cap(r, 120)) }
        : null;
    case "mock": {
      const mock = value.mock;
      if (!isObject(mock) || !isString(mock.id) || !isString(mock.title)) return null;
      if (typeof mock.minutes !== "number" || typeof mock.question_count !== "number") return null;
      return {
        type: "mock",
        mock: { id: mock.id, title: mock.title, minutes: mock.minutes, question_count: mock.question_count },
      };
    }
    default:
      return null;
  }
}

/** A stored `blocks` column: ordered text and blocks, unreadable entries dropped. */
export function parseSegments(value: unknown): CoachSegment[] | null {
  if (!Array.isArray(value)) return null;
  const segments: CoachSegment[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    if (entry.type === "text" && isString(entry.text)) {
      segments.push({ type: "text", text: entry.text });
    } else if (entry.type === "block") {
      const block = parseCoachBlock(entry.block);
      if (block) segments.push({ type: "block", block });
    }
  }
  return segments;
}

export function parseEventMeta(value: unknown): EventMeta | null {
  if (!isObject(value)) return null;
  if (value.kind === "open") return { kind: "open" };
  if (value.kind === "attempt" && isString(value.attempt_id) && isString(value.question_id)) {
    if (typeof value.right !== "number" || typeof value.total !== "number") return null;
    const meta: EventMeta = {
      kind: "attempt",
      attempt_id: value.attempt_id,
      question_id: value.question_id,
      right: value.right,
      total: value.total,
    };
    if (typeof value.earned === "number" && typeof value.possible === "number") {
      meta.earned = value.earned;
      meta.possible = value.possible;
    }
    return meta;
  }
  if (value.kind === "mock_submitted" && isString(value.mock_id) && isString(value.title) && typeof value.pct === "number") {
    return { kind: "mock_submitted", mock_id: value.mock_id, title: value.title, pct: value.pct };
  }
  return null;
}

/**
 * One line standing in for a block in the conversation history the model
 * reads on later turns. Never includes a key or an explanation.
 */
export function blockSummary(block: CoachBlock, topicTitle: (id: string) => string | null): string {
  switch (block.type) {
    case "question": {
      const kinds = block.question.parts.map((p) => p.kind.replace("_", " ")).join(", ");
      const topics = (block.question.topic_ids ?? []).map(topicTitle).filter(Boolean).join(" + ");
      return `[Practice question shown (${kinds}${topics ? `; ${topics}` : block.question.hide_topic ? "; topics hidden" : ""}): ${
        cap(block.question.stem.replace(/\s+/g, " "), 300)
      }]`;
    }
    case "stage":
      return `[Moved "${block.title}" to ${block.stage.replace("_", "-")}]`;
    case "error_logged":
      return `[Logged a mistake: ${block.error.what}]`;
    case "plan":
      return `[Saved a study plan: ${block.plan.days.map((d) => `${d.date} ${d.focus}`).join("; ")}]`;
    case "inventory":
      return `[Showed the course materials: ${block.inventory.readable} files]`;
    case "replies":
      return `[Suggested replies: ${block.replies.join(" | ")}]`;
    case "mock":
      return `[Set up a mock exam: ${block.mock.title}, ${block.mock.question_count} questions, ${block.mock.minutes} min]`;
  }
}

/** A short line for an event row, written to `content` (and shown nowhere else). */
export function eventContent(meta: EventMeta): string {
  switch (meta.kind) {
    case "open":
      return "(Opened the exam coach.)";
    case "attempt":
      return meta.possible !== undefined
        ? `(Answered the practice question: ${meta.earned} of ${meta.possible} points.)`
        : `(Answered the practice question: ${meta.right} of ${meta.total} parts right.)`;
    case "mock_submitted":
      return `(Handed in ${meta.title}: ${Math.round(meta.pct)}%.)`;
  }
}
