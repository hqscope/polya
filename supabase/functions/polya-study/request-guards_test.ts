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
}

type Call = { what: string; body?: unknown };

function backend(options: Options = {}): Call[] {
  const calls: Call[] = [];
  const claude = [...(options.claude ?? [])];
  setBackend(async (url, request) => {
    const auth = authRoute(url, request);
    if (auth) return auth;
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
        return jsonResponse(options.exams ?? [EXAM]);
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
      case "POST polya_practice_keys":
      case "POST polya_practice_attempts":
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
