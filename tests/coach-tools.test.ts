import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addDays,
  COACH_TOOLS,
  decideNext,
  validateToolInput,
  type ToolContext,
} from "../supabase/functions/_shared/coach-tools.ts";

let idCounter = 0;
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  topics: [
    { n: 1, id: "topic-a", title: "Chebyshev's inequality" },
    { n: 2, id: "topic-b", title: "Indicators" },
    { n: 3, id: "topic-c", title: "Poisson thinning" },
  ],
  today: "2026-10-20",
  examDate: "2026-10-26",
  sourceCount: 3,
  canMarkExamReady: (id) => id === "topic-b",
  newId: () => `id-${++idCounter}`,
  random: () => 0.42,
  ...over,
});

function walk(schema: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(schema)) return schema.forEach((s) => walk(s, visit));
  if (typeof schema !== "object" || schema === null) return;
  const node = schema as Record<string, unknown>;
  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
}

test("every tool schema is strict-compatible and byte-stable", () => {
  assert.equal(JSON.stringify(COACH_TOOLS), JSON.stringify(COACH_TOOLS));
  for (const tool of COACH_TOOLS) {
    assert.equal(tool.strict, true, tool.name);
    walk(tool.input_schema, (node) => {
      if (node.type === "object") {
        assert.equal(node.additionalProperties, false, `${tool.name}: closed objects`);
        assert.deepEqual(
          [...(node.required as string[])].sort(),
          Object.keys(node.properties as object).sort(),
          `${tool.name}: every property required`,
        );
      }
      for (const banned of ["minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "pattern"]) {
        assert.equal(banned in node, false, `${tool.name}: no ${banned}`);
      }
    });
  }
  assert.deepEqual(
    COACH_TOOLS.map((t) => t.name),
    ["search_course", "show_inventory", "ask_question", "set_topic_stage", "log_error", "save_plan", "suggest_replies", "create_mock_exam"],
  );
});

const numericQuestion = {
  topics: [1, 2],
  hide_topic: true,
  difficulty: "exam_hard",
  stem: "X is integer-valued with mean 15 and variance 10.",
  parts: [
    {
      kind: "numeric",
      prompt: "Chebyshev's upper bound on \\(P(X > 20)\\)?",
      answer_expr: "10/36",
      options: [],
      rubric: [],
      model_answer: "",
      points: 0,
    },
    {
      kind: "free_response",
      prompt: "Explain why \\(X > 20\\) is the same as \\(X \\ge 21\\) here.",
      answer_expr: "",
      options: [],
      rubric: ["X is integer-valued", "so the next value above 20 is 21"],
      model_answer: "Because X only takes integers, X > 20 means X ≥ 21.",
      points: 2,
    },
  ],
  explanation: "Since X is an integer, \\(P(X>20)=P(X\\ge 21)\\le P(|X-15|\\ge 6)\\le 10/36\\) [1].",
};

test("ask_question maps topic numbers, checks the key, and never trusts typed numbers", () => {
  const checked = validateToolInput("ask_question", numericQuestion, ctx());
  assert.ok(checked.ok, checked.ok ? "" : checked.error);
  assert.equal(checked.value.name, "ask_question");
  if (checked.value.name !== "ask_question") return;
  assert.deepEqual(checked.value.topicIds, ["topic-a", "topic-b"]);
  assert.equal(checked.value.difficulty, 3);
  assert.equal(checked.value.hideTopic, true);
  assert.deepEqual(checked.value.question.keys[0], { kind: "numeric", expr: "10/36", value: 10 / 36 });
  assert.deepEqual(checked.value.question.parts[1], {
    kind: "free_response",
    prompt: "Explain why \\(X > 20\\) is the same as \\(X \\ge 21\\) here.",
    points: 2,
  });
  // The public parts carry no answers.
  assert.equal(JSON.stringify(checked.value.question.parts).includes("10/36"), false);
});

test("ask_question refuses unknown topics and keys that don't evaluate, saying what to fix", () => {
  const unknown = validateToolInput("ask_question", { ...numericQuestion, topics: [9] }, ctx());
  assert.equal(unknown.ok, false);
  assert.match(unknown.ok ? "" : unknown.error, /T9/);

  const bad = structuredClone(numericQuestion);
  bad.parts[0]!.answer_expr = "about 0.28";
  const result = validateToolInput("ask_question", bad, ctx());
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /calculator expression/);
});

test("exam-ready is gated on recent evidence", () => {
  const no = validateToolInput("set_topic_stage", { topic: 1, stage: "exam_ready", note: "" }, ctx());
  assert.equal(no.ok, false);
  assert.match(no.ok ? "" : no.error, /isn't exam-ready/);
  const yes = validateToolInput("set_topic_stage", { topic: 2, stage: "exam_ready", note: "5 clean answers" }, ctx());
  assert.ok(yes.ok);
  const practicing = validateToolInput("set_topic_stage", { topic: 1, stage: "practicing", note: "" }, ctx());
  assert.ok(practicing.ok);
});

test("plans stay between today and the exam, get ids, and merge repeated dates", () => {
  const plan = validateToolInput(
    "save_plan",
    {
      days: [
        { date: "2026-10-22", focus: "Mixed", tasks: [{ topic: 0, text: "Mock exam" }] },
        { date: "2026-10-20", focus: "Chebyshev", tasks: [{ topic: 1, text: "Integer thresholds" }] },
        { date: "2026-10-20", focus: "", tasks: [{ topic: 2, text: "Dependent indicators" }] },
      ],
      note: "Weakest first.",
    },
    ctx(),
  );
  assert.ok(plan.ok);
  if (!plan.ok || plan.value.name !== "save_plan") return;
  assert.deepEqual(plan.value.plan.days.map((d) => d.date), ["2026-10-20", "2026-10-22"]);
  assert.deepEqual(plan.value.plan.days[0]!.items.map((i) => i.topic_id), ["topic-a", "topic-b"]);
  assert.ok(plan.value.plan.days[0]!.items.every((i) => i.id.startsWith("id-") && i.done === false));

  const late = validateToolInput("save_plan", { days: [{ date: "2026-10-30", focus: "x", tasks: [{ topic: 0, text: "y" }] }], note: "" }, ctx());
  assert.equal(late.ok, false);
  const noDate = validateToolInput(
    "save_plan",
    { days: [{ date: addDays("2026-10-20", 14), focus: "x", tasks: [{ topic: 0, text: "y" }] }], note: "" },
    ctx({ examDate: null }),
  );
  assert.ok(noDate.ok);
});

test("replies, errors and mocks are capped and mapped", () => {
  const replies = validateToolInput("suggest_replies", { replies: ["Next", "Next", "Slower", "Mix it", "Harder", "Again"] }, ctx());
  assert.ok(replies.ok && replies.value.name === "suggest_replies" && replies.value.replies.length === 4);
  const error = validateToolInput("log_error", { topic: 0, what: "Read X>20 as X≥20", why: "", fix: "" }, ctx());
  assert.ok(error.ok && error.value.name === "log_error" && error.value.topicId === null);
  const mock = validateToolInput(
    "create_mock_exam",
    { title: "Mock midterm", minutes: 110, question_count: 8, topics: [{ topic: 1, weight: 2 }, { topic: 3, weight: 1 }], free_response: true },
    ctx(),
  );
  assert.ok(mock.ok && mock.value.name === "create_mock_exam");
  if (mock.ok && mock.value.name === "create_mock_exam") {
    assert.deepEqual(mock.value.spec.topic_weights, { "topic-a": 2, "topic-c": 1 });
  }
  assert.equal(validateToolInput("create_mock_exam", { title: "x", minutes: 500, question_count: 8, topics: [{ topic: 1, weight: 1 }], free_response: false }, ctx()).ok, false);
  assert.equal(validateToolInput("nope", {}, ctx()).ok, false);
});

test("decideNext: when a turn calls the model again", () => {
  const base = { stopReason: "tool_use", callIndex: 0, maxCalls: 3, turnHasText: false };
  assert.equal(decideNext({ ...base, stopReason: "end_turn", outcomes: [] }), "end");
  assert.equal(decideNext({ ...base, outcomes: [{ name: "ask_question", ok: true }] }), "end");
  assert.equal(decideNext({ ...base, outcomes: [{ name: "ask_question", ok: false }] }), "continue");
  assert.equal(decideNext({ ...base, outcomes: [{ name: "show_inventory", ok: true }] }), "continue");
  assert.equal(decideNext({ ...base, turnHasText: true, outcomes: [{ name: "save_plan", ok: true }] }), "end");
  assert.equal(decideNext({ ...base, outcomes: [{ name: "save_plan", ok: true }] }), "continue");
  assert.equal(decideNext({ ...base, callIndex: 2, outcomes: [{ name: "search_course", ok: true }] }), "end");
});
