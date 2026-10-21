// polya-study through its real handler against a fake backend
// (_shared/test-serve.ts): method and body guards, the hourly window and
// daily caps failing closed, ownership, the AI budget, the write → fixed-rule
// check → independent check pipeline, and grading without a model.
//
// Run: deno test --allow-env --allow-read --no-check supabase/functions/polya-study/
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  authRoute,
  jsonResponse,
  loadHandler,
  rpcName,
  setBackend,
  TEST_SERVICE_ROLE_KEY,
  TEST_USER_ID,
  TEST_USER_JWT,
} from "../_shared/test-serve.ts";

const handler = await loadHandler(new URL("./index.ts", import.meta.url).href);
const URL_ = "http://polya.test/functions/v1/polya-study";
const COURSE_ID = "00000000-0000-4000-8000-0000000000c1";
const EXAM_ID = "00000000-0000-4000-8000-0000000000e1";
const TOPIC_ID = "00000000-0000-4000-8000-0000000000a1";
const QUESTION_ID = "00000000-0000-4000-8000-0000000000b1";

const EXAM = { id: EXAM_ID, course_id: COURSE_ID, title: "Final", exam_date: null, scope_note: null, examples_note: null };
const TOPIC = { id: TOPIC_ID, title: "Complement rule", summary: "Use complements.", key_formulas: ["P(A^c) = 1 - P(A)"] };

function claudeReply(value: unknown): Response {
  return jsonResponse({
    stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(value) }],
    usage: { input_tokens: 100, output_tokens: 50 },
  });
}

const DIE_QUESTION = {
  stem: "A fair die is rolled 3 times.",
  parts: [{ kind: "numeric", prompt: "\\(P(\\text{at least one six})\\)?", answer_expr: "1 - (5/6)^3", options: [] }],
  explanation: "Complement: \\(1 - (5/6)^3\\).",
};

interface Options {
  hourly?: boolean;
  dailyTotal?: number;
  budget?: "allow" | "deny";
  exams?: unknown[];
  claude?: Response[];
  question?: unknown[];
  key?: unknown[];
  mocks?: unknown[];
  plan?: unknown;
  attempts?: unknown[];
}

type Call = { what: string; body?: unknown };

function backend(options: Options = {}): Call[] {
  const calls: Call[] = [];
  const claude = [...(options.claude ?? [])];
  setBackend(async (url, request) => {
    const auth = authRoute(url, request);
    if (auth) return auth;
    // GoTrue's admin lookup: answers only for the service-role key (the iMessage caller's check).
    const admin = url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/);
    if (admin) {
      calls.push({ what: "auth admin lookup" });
      if (request.headers.get("apikey") !== TEST_SERVICE_ROLE_KEY) return jsonResponse({ msg: "not admin" }, 401);
      return admin[1] === TEST_USER_ID ? jsonResponse({ id: TEST_USER_ID }) : jsonResponse({ msg: "User not found" }, 404);
    }
    if (url.hostname === "api.anthropic.com") {
      calls.push({ what: "claude", body: await request.json() });
      return claude.shift() ?? jsonResponse({ error: "no reply queued" }, 500);
    }
    const rpc = rpcName(url);
    if (rpc) {
      calls.push({ what: `rpc ${rpc}` });
      if (rpc === "claim_rate_limit") return jsonResponse(options.hourly ?? true);
      if (rpc === "increment_usage_daily") return jsonResponse(options.dailyTotal ?? 1);
      if (rpc === "claim_ai_budget") return jsonResponse(options.budget ?? "allow");
      return jsonResponse([]); // retrieval: no matching course text
    }
    const table = url.pathname.replace("/rest/v1/", "");
    const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
    calls.push({ what: `${request.method} ${table}`, body });
    switch (`${request.method} ${table}`) {
      case "GET polya_exams":
        return jsonResponse(options.plan !== undefined ? [{ id: EXAM_ID, plan: options.plan }] : options.exams ?? [EXAM]);
      case "GET polya_mock_exams":
        return jsonResponse(options.mocks ?? []);
      case "GET polya_practice_attempts":
        return jsonResponse(options.attempts ?? []);
      case "PATCH polya_mock_exams":
      case "PATCH polya_exams":
        return jsonResponse(null, 200);
      case "GET polya_study_topics":
        return jsonResponse([TOPIC]);
      case "GET polya_courses":
        return jsonResponse([{ name: "Stat 134" }]);
      case "GET polya_exam_sources":
        return jsonResponse([]);
      case "GET polya_practice_questions":
        return jsonResponse(options.question ?? []);
      case "GET polya_practice_keys":
        return jsonResponse(options.key ?? []);
      case "POST polya_practice_questions":
        return jsonResponse({ id: QUESTION_ID, ...(body as object), status: "active", created_at: "2026-12-01T00:00:00Z" }, 201);
      case "POST polya_practice_attempts":
        return jsonResponse({ id: "00000000-0000-4000-8000-0000000000d1", created_at: "2026-12-01T00:00:00Z" }, 201);
      case "POST polya_practice_keys":
      case "POST polya_events":
        return jsonResponse(null, 201);
      default:
        return null;
    }
  });
  return calls;
}

function post(body: unknown, auth = true): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${TEST_USER_JWT}` } : {}) },
    body: JSON.stringify(body),
  });
}

const GENERATE = { action: "generate_questions", exam_id: EXAM_ID, topic_id: TOPIC_ID };
const names = (calls: Call[]) => calls.map((c) => c.what);

// --- guards ------------------------------------------------------------------

Deno.test("non-POST is 405; OPTIONS answers the preflight", async () => {
  backend();
  for (const method of ["GET", "PUT", "DELETE"]) {
    const response = await handler(new Request(URL_, { method }));
    assertEquals(response.status, 405);
    await response.body?.cancel();
  }
  const preflight = await handler(new Request(URL_, { method: "OPTIONS" }));
  assertEquals(preflight.status, 200);
  await preflight.body?.cancel();
});

Deno.test("no session is a 401 and touches nothing else", async () => {
  const calls = backend();
  const response = await handler(post(GENERATE, false));
  assertEquals(response.status, 401);
  await response.body?.cancel();
  assertEquals(calls, []);
});

Deno.test("the hourly window fails closed before any lookup", async () => {
  const calls = backend({ hourly: false });
  const response = await handler(post(GENERATE));
  assertEquals(response.status, 429);
  assertEquals((await response.json()).code, "rate_limited");
  assertEquals(names(calls), ["rpc claim_rate_limit"]);
});

Deno.test("unknown actions and malformed ids are 400s", async () => {
  backend();
  for (const body of [{ action: "nope" }, { ...GENERATE, exam_id: "x" }, { action: "submit_attempt", question_id: 4 }]) {
    const response = await handler(post(body));
    assertEquals(response.status, 400, JSON.stringify(body));
    await response.body?.cancel();
  }
});

Deno.test("someone else's exam is a 404, before any cap or model call", async () => {
  const calls = backend({ exams: [] });
  const response = await handler(post(GENERATE));
  assertEquals(response.status, 404);
  await response.body?.cancel();
  assert(!names(calls).some((n) => n.startsWith("rpc increment") || n === "claude"));
});

Deno.test("the daily cap and the AI budget both refuse before Claude is called", async () => {
  let calls = backend({ dailyTotal: 99 });
  let response = await handler(post(GENERATE));
  assertEquals(response.status, 429);
  await response.body?.cancel();
  assert(!names(calls).includes("claude"));

  calls = backend({ budget: "deny" });
  response = await handler(post(GENERATE));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).code, "busy");
  assert(!names(calls).includes("claude"));
});

// --- the pipeline ------------------------------------------------------------

Deno.test("a question is saved only when the independent check agrees", async () => {
  let calls = backend({
    claude: [
      claudeReply({ questions: [DIE_QUESTION] }),
      claudeReply({ answers: [{ problem: "", parts: [{ answer_expr: "1 - 125/216", choices: [] }] }] }),
    ],
  });
  let response = await handler(post(GENERATE));
  assertEquals(response.status, 200);
  let result = await response.json();
  assertEquals(result.kept, 1);
  assertEquals(result.questions[0].parts, [{ kind: "numeric", prompt: DIE_QUESTION.parts[0].prompt }]);
  const key = calls.find((c) => c.what === "POST polya_practice_keys")!.body as { answers: { value: number }[] };
  assert(Math.abs(key.answers[0].value - 0.4212963) < 1e-6);
  // The checker saw the question but never the key or the explanation.
  const checker = JSON.stringify(calls.filter((c) => c.what === "claude")[1]!.body);
  assert(checker.includes("A fair die is rolled 3 times."));
  assert(!checker.includes("Complement: "));
  assert(!checker.includes("1 - (5/6)^3"));

  calls = backend({
    claude: [
      claudeReply({ questions: [DIE_QUESTION] }),
      claudeReply({ answers: [{ problem: "", parts: [{ answer_expr: "(5/6)^3", choices: [] }] }] }),
    ],
  });
  response = await handler(post(GENERATE));
  result = await response.json();
  assertEquals(result.kept, 0);
  assert(!names(calls).includes("POST polya_practice_questions"), "a disputed key is never saved");
});

Deno.test("a key that doesn't evaluate never reaches the checker", async () => {
  const bad = { ...DIE_QUESTION, parts: [{ ...DIE_QUESTION.parts[0], answer_expr: "about half" }] };
  const calls = backend({ claude: [claudeReply({ questions: [bad] })] });
  const response = await handler(post(GENERATE));
  assertEquals((await response.json()).kept, 0);
  assertEquals(names(calls).filter((n) => n === "claude").length, 1);
});

Deno.test("a declined or failed writer call is a friendly error", async () => {
  backend({ claude: [jsonResponse({ stop_reason: "refusal", stop_details: { category: "bio" }, content: [] })] });
  let response = await handler(post(GENERATE));
  assertEquals(response.status, 422);
  assertEquals((await response.json()).code, "declined");

  backend({ claude: [jsonResponse({ type: "error" }, 529)] });
  response = await handler(post(GENERATE));
  assertEquals(response.status, 503);
  await response.body?.cancel();
});

// --- grading -----------------------------------------------------------------

const QUESTION_ROW = [{ id: QUESTION_ID, exam_id: EXAM_ID, topic_id: TOPIC_ID, course_id: COURSE_ID, parts: [], sources: [] }];
const KEY_ROW = [{ answers: [{ kind: "numeric", expr: "1 - (5/6)^4", value: 0.5177469135802468 }], explanation: "Complement." }];

Deno.test("an answer is graded by fixed rules and recorded, with no model call", async () => {
  const calls = backend({ question: QUESTION_ROW, key: KEY_ROW });
  const response = await handler(
    post({ action: "submit_attempt", question_id: QUESTION_ID, responses: [{ kind: "numeric", answer: "1 - 625/1296" }] }),
  );
  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(result.all_correct, true);
  assertEquals(result.explanation, "Complement.");
  const attempt = calls.find((c) => c.what === "POST polya_practice_attempts")!.body as { score: number; all_correct: boolean };
  assertEquals(attempt.score, 1);
  assert(!names(calls).includes("claude"));
});

Deno.test("an unreadable answer is a 400 and nothing is recorded", async () => {
  const calls = backend({ question: QUESTION_ROW, key: KEY_ROW });
  const response = await handler(
    post({ action: "submit_attempt", question_id: QUESTION_ID, responses: [{ kind: "numeric", answer: "2pi" }] }),
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).code, "bad_answer");
  assert(!names(calls).includes("POST polya_practice_attempts"));
});

Deno.test("a question that isn't yours can't be answered", async () => {
  backend({ question: [], key: [] });
  const response = await handler(
    post({ action: "submit_attempt", question_id: QUESTION_ID, responses: [{ kind: "numeric", answer: "1" }] }),
  );
  assertEquals(response.status, 404);
  await response.body?.cancel();
});

// --- exam coach additions ------------------------------------------------------

const WRITTEN_QUESTION = [{
  id: QUESTION_ID,
  exam_id: EXAM_ID,
  topic_id: TOPIC_ID,
  topic_ids: [],
  course_id: COURSE_ID,
  stem: "Ten coins are tossed.",
  parts: [{ kind: "numeric", prompt: "P(10 heads)?" }, { kind: "free_response", prompt: "Why binomial?", points: 4 }],
  sources: [],
}];
const WRITTEN_KEY = [{
  answers: [
    { kind: "numeric", expr: "0.5^10", value: 0.5 ** 10 },
    { kind: "free_response", rubric: ["fixed n", "independent", "same p"], model_answer: "Bin(10, 1/2).", points: 4 },
  ],
  explanation: "Each toss is independent.",
}];

Deno.test("a written part is graded against its rubric in one call, and the attempt id comes back", async () => {
  const calls = backend({
    question: WRITTEN_QUESTION,
    key: WRITTEN_KEY,
    claude: [claudeReply({ grades: [{ item: 1, met: [1, 2], awarded: 3, feedback: "Say why p is the same.", misconception: "" }] })],
  });
  const response = await handler(post({
    action: "submit_attempt",
    question_id: QUESTION_ID,
    responses: [{ kind: "numeric", answer: "1/1024" }, { kind: "free_response", text: "Fixed number of independent tosses." }],
  }));
  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(result.attempt_id, "00000000-0000-4000-8000-0000000000d1");
  assertEquals(result.results[1].awarded, 3);
  assertEquals(result.results[1].points, 4);
  assertEquals(result.score, (1 + 0.75) / 2);
  assertEquals(names(calls).filter((n) => n === "claude").length, 1);
  const grader = calls.find((c) => c.what === "claude")!.body as { messages: { content: { text: string }[] }[] };
  assert(grader.messages[0]!.content[0]!.text.includes("<student_answer>"));
});

Deno.test("a typo in another part is a 400 before any grader call; a blank written part too", async () => {
  let calls = backend({ question: WRITTEN_QUESTION, key: WRITTEN_KEY });
  let response = await handler(post({
    action: "submit_attempt",
    question_id: QUESTION_ID,
    responses: [{ kind: "numeric", answer: "2pi" }, { kind: "free_response", text: "Because." }],
  }));
  assertEquals(response.status, 400);
  await response.body?.cancel();
  assert(!names(calls).includes("claude"));

  calls = backend({ question: WRITTEN_QUESTION, key: WRITTEN_KEY });
  response = await handler(post({
    action: "submit_attempt",
    question_id: QUESTION_ID,
    responses: [{ kind: "numeric", answer: "1/1024" }, { kind: "free_response", text: "   " }],
  }));
  assertEquals(response.status, 400);
  assertEquals((await response.json()).part, 1);
  assert(!names(calls).includes("claude"));
});

Deno.test("a question waiting in a mock exam can't be answered early", async () => {
  const calls = backend({
    question: QUESTION_ROW,
    key: KEY_ROW,
    mocks: [{ id: "00000000-0000-4000-8000-0000000000c8", question_ids: [QUESTION_ID] }],
  });
  const response = await handler(
    post({ action: "submit_attempt", question_id: QUESTION_ID, responses: [{ kind: "numeric", answer: "1" }] }),
  );
  assertEquals(response.status, 409);
  await response.body?.cancel();
  assert(!names(calls).includes("POST polya_practice_attempts"));
});

const MOCK_ID = "00000000-0000-4000-8000-0000000000c9";

Deno.test("a handed-in mock: blanks count as wrong, no grader for blank writing, report stored", async () => {
  const mock = {
    id: MOCK_ID,
    exam_id: EXAM_ID,
    course_id: COURSE_ID,
    title: "Mock midterm",
    minutes: 50,
    spec: { question_count: 3, topic_weights: { [TOPIC_ID]: 1 }, free_response: true },
    question_ids: [QUESTION_ID],
    status: "in_progress",
    started_at: "2026-12-01T10:00:00Z",
    due_at: "2026-12-01T10:50:00Z",
    submitted_at: null,
    score: null,
    report: null,
  };
  const calls = backend({
    mocks: [mock],
    question: WRITTEN_QUESTION,
    key: [{ question_id: QUESTION_ID, ...WRITTEN_KEY[0] }],
  });
  const response = await handler(post({
    action: "submit_mock",
    mock_id: MOCK_ID,
    answers: [{ question_id: QUESTION_ID, responses: [{ kind: "numeric", answer: "" }, { kind: "free_response", text: "" }] }],
  }));
  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(result.report.score, 0);
  assertEquals(result.report.missed, [QUESTION_ID]);
  assert(!names(calls).includes("claude"));
  const attempts = calls.find((c) => c.what === "POST polya_practice_attempts")!.body as { mock_id: string; score: number }[];
  assertEquals(attempts[0]!.mock_id, MOCK_ID);
  assertEquals(attempts[0]!.score, 0);
  const update = calls.filter((c) => c.what === "PATCH polya_mock_exams").map((c) => c.body as Record<string, unknown>);
  assert(update.some((u) => u.status === "submitted" && (u.report as { possible: number }).possible === 1));
});

Deno.test("ticking a plan item updates only that item", async () => {
  const plan = {
    days: [{ date: "2026-12-02", focus: "x", items: [{ id: "i1", topic_id: null, text: "a", done: false }, { id: "i2", topic_id: null, text: "b", done: false }] }],
    note: "",
  };
  const calls = backend({ plan });
  const response = await handler(post({ action: "toggle_plan_item", exam_id: EXAM_ID, item_id: "i2", done: true }));
  assertEquals(response.status, 200);
  const saved = calls.find((c) => c.what === "PATCH polya_exams")!.body as { plan: typeof plan };
  assertEquals(saved.plan.days[0]!.items.map((i) => i.done), [false, true]);
});

// --- the iMessage agent's service caller --------------------------------------

function servicePost(body: unknown, userId: string | null = TEST_USER_ID, key = TEST_SERVICE_ROLE_KEY): Request {
  return new Request(URL_, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...(userId ? { "x-polya-user-id": userId } : {}),
    },
    body: JSON.stringify(body),
  });
}

Deno.test("the service caller grades for the named student, without a session lookup", async () => {
  const calls = backend({ question: QUESTION_ROW, key: KEY_ROW });
  const response = await handler(
    servicePost({ action: "submit_attempt", question_id: QUESTION_ID, responses: [{ kind: "numeric", answer: "1 - 625/1296" }] }),
  );
  assertEquals(response.status, 200);
  assertEquals((await response.json()).all_correct, true);
  // A 200 at all means no session lookup: the fake GoTrue only accepts TEST_USER_JWT.
  const attempt = calls.find((c) => c.what === "POST polya_practice_attempts")!.body as { user_id: string };
  assertEquals(attempt.user_id, TEST_USER_ID);
});

Deno.test("the service caller writes questions through the user-scoped retrieval twins", async () => {
  const calls = backend({
    claude: [
      claudeReply({ questions: [DIE_QUESTION] }),
      claudeReply({ answers: [{ problem: "", parts: [{ answer_expr: "1 - 125/216", choices: [] }] }] }),
    ],
  });
  const response = await handler(servicePost(GENERATE));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).kept, 1);
  const rpcs = names(calls).filter((n) => n.startsWith("rpc polya_"));
  assertEquals(rpcs.sort(), ["rpc polya_match_units_for_user", "rpc polya_search_units_fts_for_user"]);
});

Deno.test("the service caller is limited to grading and writing questions", async () => {
  for (const body of [
    { action: "build_mock", mock_id: QUESTION_ID },
    { action: "toggle_plan_item", exam_id: EXAM_ID, item_id: "d1-0", done: true },
    { action: "propose_topics", exam_id: EXAM_ID },
  ]) {
    const calls = backend();
    const response = await handler(servicePost(body));
    assertEquals(response.status, 403, JSON.stringify(body));
    assertEquals((await response.json()).code, "forbidden");
    assertEquals(calls, []);
  }
});

Deno.test("without a named student the key is just a bad session; a malformed id is a 400", async () => {
  let calls = backend();
  let response = await handler(servicePost(GENERATE, null));
  assertEquals(response.status, 401);
  await response.body?.cancel();
  assertEquals(calls, []);

  calls = backend();
  response = await handler(servicePost(GENERATE, "not-a-uuid"));
  assertEquals(response.status, 400);
  await response.body?.cancel();
  assertEquals(calls, []);
});

Deno.test("a wrong key, or a student who doesn't exist, is a 401 before any window or lookup", async () => {
  for (const [userId, key] of [
    [TEST_USER_ID, "not-the-service-key"],
    ["00000000-0000-4000-8000-0000000000ff", TEST_SERVICE_ROLE_KEY],
  ] as const) {
    const calls = backend();
    const response = await handler(servicePost(GENERATE, userId, key));
    assertEquals(response.status, 401);
    await response.body?.cancel();
    assertEquals(names(calls), ["auth admin lookup"]);
  }
  // A student's own session can't borrow the path either.
  const calls = backend();
  const response = await handler(servicePost(GENERATE, TEST_USER_ID, TEST_USER_JWT));
  assertEquals(response.status, 401);
  await response.body?.cancel();
  assertEquals(names(calls), ["auth admin lookup"]);
});
