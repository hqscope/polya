// The exam coach's tools: their definitions (sent on every call, byte-stable
// so the prompt cache holds), the checks every call's input must pass before
// anything is written, and when a turn should stop calling the model.
//
// The model names topics by their number in <exam_state> (T1, T2, …), never
// by id; the server maps numbers to ids, so a made-up id can't reach a write.
// Every question's key is checked by the same fixed rules as the question
// bank (prepareQuestion): numbers are computed here, never typed by the model.
//
// Pure module: no runtime globals.

import { asWriterPart, MAX_PARTS, prepareQuestion, type PreparedQuestion, type WriterPart } from "./study-questions.ts";
import { MOCK_MAX_MINUTES, MOCK_MAX_QUESTIONS, MOCK_MIN_MINUTES, validateMockSpec, type MockSpec } from "./study-mock.ts";
import type { StoredStage } from "./study-progress.ts";
import type { StudyPlan } from "./coach-blocks.ts";

export type ToolName =
  | "search_course"
  | "show_inventory"
  | "ask_question"
  | "set_topic_stage"
  | "log_error"
  | "save_plan"
  | "suggest_replies"
  | "create_mock_exam";

/**
 * data: its result is something the model should read before finishing.
 * terminal: once it succeeds the turn ends (the student acts next).
 * bookkeeping: records something; the turn can end right after.
 */
export const TOOL_KIND: Record<ToolName, "data" | "terminal" | "bookkeeping"> = {
  search_course: "data",
  show_inventory: "data",
  ask_question: "terminal",
  create_mock_exam: "terminal",
  set_topic_stage: "bookkeeping",
  log_error: "bookkeeping",
  save_plan: "bookkeeping",
  suggest_replies: "bookkeeping",
};

export const MAX_REPLIES = 4;
const MAX_REPLY_CHARS = 80;
const MAX_PLAN_DAYS = 21;
const MAX_PLAN_TASKS = 5;
const DEFAULT_PLAN_WINDOW_DAYS = 14;
const MAX_QUERY_CHARS = 300;
const MAX_TOPICS_PER_QUESTION = 4;

const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const OPTION = object({
  expr: { type: "string", description: "The option's value as a calculator expression; \"\" for a statement option." },
  text: { type: "string", description: "The statement shown; \"\" for a value option." },
  correct: { type: "boolean" },
});

const PART = object({
  kind: {
    type: "string",
    enum: ["numeric", "mc", "select_all", "free_response"],
    description: "numeric: type a number. mc: choose one. select_all: select all that apply. free_response: a written explanation or derivation.",
  },
  prompt: { type: "string" },
  answer_expr: { type: "string", description: "numeric and value-option mc parts: the exact answer as a calculator expression. Otherwise \"\"." },
  options: { type: "array", items: OPTION, description: "mc and select_all only (3 to 5); [] otherwise." },
  rubric: {
    type: "array",
    items: { type: "string" },
    description: "free_response only: 2 to 5 checkable points a grader can see in a good answer. [] otherwise.",
  },
  model_answer: { type: "string", description: "free_response only: a complete answer in the course's notation. \"\" otherwise." },
  points: { type: "integer", description: "free_response only: 2 to 6. 0 otherwise." },
});

/** Sent with every coach call, in this order. Never build this per request. */
export const COACH_TOOLS = [
  {
    name: "search_course",
    description:
      "Search this course's materials (lectures, readings, past exams, worksheets) for more passages to teach from. Call it only when the evidence already in this turn doesn't cover what you need. Returns numbered passages to cite as [n].",
    strict: true,
    input_schema: object({ query: { type: "string", description: "A few words or a question." } }),
  },
  {
    name: "show_inventory",
    description:
      "Show the student a summary of their course materials: counts by kind, practice exams and whether each has an answer key, and files that couldn't be read. Call it on the first visit, or when the student asks what Polya has from their course.",
    strict: true,
    input_schema: object({}),
  },
  {
    name: "ask_question",
    description:
      "Put one practice question in front of the student as an interactive card, graded the moment they submit. Use it for every practice question; never write a question's answer or hints in your message. After it succeeds, end your message: the student answers next.",
    strict: true,
    input_schema: object({
      topics: {
        type: "array",
        items: { type: "integer" },
        description: "Topic numbers from <exam_state> (the n in Tn). One topic, or 2 to 4 for a mixed question.",
      },
      hide_topic: {
        type: "boolean",
        description: "true for mixed or unannounced review questions: the card doesn't name the topic until it's answered.",
      },
      difficulty: { type: "string", enum: ["warm_up", "standard", "exam_hard"] },
      stem: { type: "string", description: "The scenario every part refers to." },
      parts: { type: "array", items: PART, description: "1 to 4 parts." },
      explanation: {
        type: "string",
        description: "The worked solution of every part, shown after the student answers. Cite course evidence as [n].",
      },
    }),
  },
  {
    name: "set_topic_stage",
    description:
      "Record where the student stands on a topic: learning (you're teaching it), practicing (they're answering questions), or exam_ready (consistently right on recent questions, including a written or unannounced one). Call it when the stage changes.",
    strict: true,
    input_schema: object({
      topic: { type: "integer", description: "Topic number from <exam_state>." },
      stage: { type: "string", enum: ["learning", "practicing", "exam_ready"] },
      note: { type: "string", description: "One short line on why." },
    }),
  },
  {
    name: "log_error",
    description:
      "Add a mistake to the student's mistake log: a real misconception or a recurring trap, not a one-off slip. Don't log one that duplicates an open E item in <exam_state>.",
    strict: true,
    input_schema: object({
      topic: { type: "integer", description: "Topic number from <exam_state>, or 0 if none fits." },
      what: { type: "string", description: "What went wrong, in one line." },
      why: { type: "string", description: "The idea behind the mistake." },
      fix: { type: "string", description: "How to avoid it next time." },
    }),
  },
  {
    name: "save_plan",
    description:
      "Save the student's study plan for the days until the exam, replacing any earlier plan. Call it when there's no plan yet, when the student asks for one, or when progress means the plan should change.",
    strict: true,
    input_schema: object({
      days: {
        type: "array",
        items: object({
          date: { type: "string", description: "YYYY-MM-DD, from today through the exam date." },
          focus: { type: "string", description: "The day's theme in a few words." },
          tasks: {
            type: "array",
            items: object({
              topic: { type: "integer", description: "Topic number, or 0 for a general task (a mock exam, review)." },
              text: { type: "string" },
            }),
            description: "1 to 5 concrete tasks.",
          },
        }),
      },
      note: { type: "string", description: "One or two sentences on the plan's shape." },
    }),
  },
  {
    name: "suggest_replies",
    description:
      "Offer up to 4 short replies the student can tap, written in the student's voice (\"Give me a harder one\", \"Explain that more slowly\"). Use it at the end of a message when there are obvious next steps.",
    strict: true,
    input_schema: object({ replies: { type: "array", items: { type: "string" } } }),
  },
  {
    name: "create_mock_exam",
    description:
      "Set up a timed mock exam in the style of the course's past exams, with no help or answers until it's handed in. Offer it once most topics are exam-ready or the exam is 3 days away or less, and call this when the student agrees. After it succeeds, end your message.",
    strict: true,
    input_schema: object({
      title: { type: "string" },
      minutes: { type: "integer", description: `${MOCK_MIN_MINUTES} to ${MOCK_MAX_MINUTES}; match the real exam's length when known.` },
      question_count: { type: "integer", description: `3 to ${MOCK_MAX_QUESTIONS}.` },
      topics: {
        type: "array",
        items: object({ topic: { type: "integer" }, weight: { type: "integer", description: "1 to 5." } }),
        description: "The topics to cover and how heavily.",
      },
      free_response: { type: "boolean", description: "Include written explain-or-derive parts, as the real exam does." },
    }),
  },
] as const;

export const TOOL_NAMES = new Set<string>(COACH_TOOLS.map((tool) => tool.name));

// ---------------------------------------------------------------------------
// Input checks. Error strings go back to the model as the tool result, so
// they say exactly what to change.
// ---------------------------------------------------------------------------
export interface ToolTopic {
  n: number;
  id: string;
  title: string;
}

export interface ToolContext {
  topics: readonly ToolTopic[];
  /** YYYY-MM-DD in the student's time zone. */
  today: string;
  examDate: string | null;
  /** How many evidence passages are numbered so far this turn (for [n] checks). */
  sourceCount: number;
  canMarkExamReady: (topicId: string) => boolean;
  newId: () => string;
  random?: () => number;
}

export type ToolInput =
  | { name: "search_course"; query: string }
  | { name: "show_inventory" }
  | { name: "ask_question"; topicIds: string[]; hideTopic: boolean; difficulty: 1 | 2 | 3; question: PreparedQuestion }
  | { name: "set_topic_stage"; topicId: string; title: string; stage: StoredStage; note: string }
  | { name: "log_error"; topicId: string | null; what: string; why: string; fix: string }
  | { name: "save_plan"; plan: StudyPlan }
  | { name: "suggest_replies"; replies: string[] }
  | { name: "create_mock_exam"; title: string; minutes: number; spec: MockSpec };

export type Checked = { ok: true; value: ToolInput } | { ok: false; error: string };

const fail = (error: string): Checked => ({ ok: false, error });
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\r\n?/g, "\n").trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};

const DIFFICULTY: Record<string, 1 | 2 | 3> = { warm_up: 1, standard: 2, exam_hard: 3 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function topicByNumber(ctx: ToolContext, n: unknown): ToolTopic | null {
  if (typeof n !== "number" || !Number.isInteger(n)) return null;
  return ctx.topics.find((t) => t.n === n) ?? null;
}

/** YYYY-MM-DD plus `days`, in UTC arithmetic (dates only). */
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function validateToolInput(name: string, input: unknown, ctx: ToolContext): Checked {
  if (!TOOL_NAMES.has(name)) return fail(`There is no tool named ${name}.`);
  if (!isObject(input)) return fail("The input couldn't be read. Send it again as a JSON object.");
  switch (name as ToolName) {
    case "search_course": {
      const query = text(input.query, MAX_QUERY_CHARS);
      return query ? { ok: true, value: { name: "search_course", query } } : fail("query must be 1 to 300 characters.");
    }
    case "show_inventory":
      return { ok: true, value: { name: "show_inventory" } };
    case "ask_question":
      return checkQuestion(input, ctx);
    case "set_topic_stage": {
      const topic = topicByNumber(ctx, input.topic);
      if (!topic) return fail("topic must be a topic number from <exam_state>.");
      const stage = input.stage;
      if (stage !== "learning" && stage !== "practicing" && stage !== "exam_ready") {
        return fail("stage must be learning, practicing or exam_ready.");
      }
      if (stage === "exam_ready" && !ctx.canMarkExamReady(topic.id)) {
        return fail(
          `T${topic.n} isn't exam-ready yet: it needs at least 3 recent answers averaging 80% or better. Keep it at practicing and give more questions.`,
        );
      }
      return {
        ok: true,
        value: { name: "set_topic_stage", topicId: topic.id, title: topic.title, stage, note: text(input.note, 500) ?? "" },
      };
    }
    case "log_error": {
      const topic = input.topic === 0 ? null : topicByNumber(ctx, input.topic);
      if (input.topic !== 0 && !topic) return fail("topic must be a topic number from <exam_state>, or 0.");
      const what = text(input.what, 300);
      if (!what) return fail("what must be 1 to 300 characters.");
      return {
        ok: true,
        value: {
          name: "log_error",
          topicId: topic?.id ?? null,
          what,
          why: text(input.why, 600) ?? "",
          fix: text(input.fix, 600) ?? "",
        },
      };
    }
    case "save_plan":
      return checkPlan(input, ctx);
    case "suggest_replies": {
      if (!Array.isArray(input.replies)) return fail("replies must be a list of strings.");
      const replies = [
        ...new Set(input.replies.map((r) => text(r, MAX_REPLY_CHARS)).filter((r): r is string => r !== null)),
      ].slice(0, MAX_REPLIES);
      return replies.length > 0 ? { ok: true, value: { name: "suggest_replies", replies } } : fail("Give 1 to 4 replies.");
    }
    case "create_mock_exam": {
      const title = text(input.title, 120);
      if (!title) return fail("title must be 1 to 120 characters.");
      const minutes = input.minutes;
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < MOCK_MIN_MINUTES || minutes > MOCK_MAX_MINUTES) {
        return fail(`minutes must be ${MOCK_MIN_MINUTES} to ${MOCK_MAX_MINUTES}.`);
      }
      if (!Array.isArray(input.topics) || input.topics.length === 0) return fail("List at least one topic.");
      const weights: Record<string, number> = {};
      for (const entry of input.topics) {
        const topic = isObject(entry) ? topicByNumber(ctx, entry.topic) : null;
        if (!topic) return fail("Each topics entry needs a topic number from <exam_state>.");
        weights[topic.id] = isObject(entry) && typeof entry.weight === "number" ? entry.weight : 0;
      }
      const spec = validateMockSpec(
        { question_count: input.question_count, topic_weights: weights, free_response: input.free_response === true },
        ctx.topics.map((t) => t.id),
      );
      if (!spec.ok) return fail(`The mock exam couldn't be set up: ${spec.error}.`);
      return { ok: true, value: { name: "create_mock_exam", title, minutes, spec: spec.spec } };
    }
  }
}

function checkQuestion(input: Record<string, unknown>, ctx: ToolContext): Checked {
  if (!Array.isArray(input.topics) || input.topics.length === 0 || input.topics.length > MAX_TOPICS_PER_QUESTION) {
    return fail("topics must list 1 to 4 topic numbers.");
  }
  const topicIds: string[] = [];
  for (const n of input.topics) {
    const topic = topicByNumber(ctx, n);
    if (!topic) return fail(`T${String(n)} isn't a topic in <exam_state>.`);
    if (!topicIds.includes(topic.id)) topicIds.push(topic.id);
  }
  const difficulty = typeof input.difficulty === "string" ? DIFFICULTY[input.difficulty] : undefined;
  if (!difficulty) return fail("difficulty must be warm_up, standard or exam_hard.");
  if (typeof input.stem !== "string" || typeof input.explanation !== "string") return fail("stem and explanation are required.");
  if (!Array.isArray(input.parts) || input.parts.length === 0 || input.parts.length > MAX_PARTS) {
    return fail(`parts must have 1 to ${MAX_PARTS} entries.`);
  }
  const parts: WriterPart[] = [];
  for (const [i, raw] of input.parts.entries()) {
    const part = asWriterPart(raw);
    if (!part) return fail(`part ${i + 1} is missing a field.`);
    parts.push(part);
  }
  const prepared = prepareQuestion(
    { stem: input.stem, parts, explanation: input.explanation },
    ctx.sourceCount,
    ctx.random,
  );
  if (!prepared.ok) {
    return fail(
      `The question wasn't shown: ${prepared.reason}. Every numeric answer and value option must be a calculator expression whose value is the answer; fix it and call ask_question again.`,
    );
  }
  return {
    ok: true,
    value: { name: "ask_question", topicIds, hideTopic: input.hide_topic === true, difficulty, question: prepared.question },
  };
}

function checkPlan(input: Record<string, unknown>, ctx: ToolContext): Checked {
  if (!Array.isArray(input.days) || input.days.length === 0) return fail("days must list at least one day.");
  const last = ctx.examDate && ctx.examDate >= ctx.today ? ctx.examDate : addDays(ctx.today, DEFAULT_PLAN_WINDOW_DAYS);
  const days = new Map<string, StudyPlan["days"][number]>();
  for (const raw of input.days) {
    if (!isObject(raw) || typeof raw.date !== "string" || !DATE_RE.test(raw.date) || Number.isNaN(Date.parse(raw.date))) {
      return fail("Each day needs a date as YYYY-MM-DD.");
    }
    if (raw.date < ctx.today || raw.date > last) return fail(`Dates must run from ${ctx.today} to ${last}.`);
    if (!Array.isArray(raw.tasks) || raw.tasks.length === 0 || raw.tasks.length > MAX_PLAN_TASKS) {
      return fail(`Each day needs 1 to ${MAX_PLAN_TASKS} tasks.`);
    }
    const items = [];
    for (const task of raw.tasks) {
      if (!isObject(task)) return fail("Each task needs a topic number and text.");
      const topic = task.topic === 0 ? null : topicByNumber(ctx, task.topic);
      if (task.topic !== 0 && !topic) return fail("A task's topic must be a topic number from <exam_state>, or 0.");
      const taskText = text(task.text, 300);
      if (!taskText) return fail("A task's text must be 1 to 300 characters.");
      items.push({ id: ctx.newId(), topic_id: topic?.id ?? null, text: taskText, done: false });
    }
    const existing = days.get(raw.date);
    if (existing) existing.items.push(...items.slice(0, MAX_PLAN_TASKS - existing.items.length));
    else days.set(raw.date, { date: raw.date, focus: text(raw.focus, 200) ?? "", items });
  }
  if (days.size > MAX_PLAN_DAYS) return fail(`A plan covers at most ${MAX_PLAN_DAYS} days.`);
  const plan: StudyPlan = {
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    note: text(input.note, 600) ?? "",
  };
  return { ok: true, value: { name: "save_plan", plan } };
}

// ---------------------------------------------------------------------------
// When to stop.
// ---------------------------------------------------------------------------
export interface CallOutcome {
  name: string;
  ok: boolean;
}

/**
 * After one model call: "continue" sends the tool results back for another
 * call; "end" finishes the turn. A turn ends when nothing was called, when a
 * terminal tool succeeded (the student acts next), when the call budget is
 * spent, or when only bookkeeping happened after text was already written.
 */
export function decideNext(input: {
  stopReason: string | null;
  outcomes: readonly CallOutcome[];
  callIndex: number; // 0-based index of the call just finished
  maxCalls: number;
  turnHasText: boolean;
}): "continue" | "end" {
  const { stopReason, outcomes, callIndex, maxCalls, turnHasText } = input;
  if (stopReason !== "tool_use" || outcomes.length === 0) return "end";
  if (outcomes.some((o) => o.ok && TOOL_KIND[o.name as ToolName] === "terminal")) return "end";
  if (callIndex + 1 >= maxCalls) return "end";
  const needsReply = outcomes.some((o) => !o.ok || TOOL_KIND[o.name as ToolName] === "data");
  if (!needsReply && turnHasText) return "end";
  return "continue";
}
