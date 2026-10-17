// polya-coach through its real handler against a fake backend
// (_shared/test-serve.ts) and a scripted Claude stream: guards, ownership,
// event dedupe, budgets failing closed, the tool loop (results go back to the
// model, thinking blocks replayed unchanged), keys never leaving the server,
// and what gets saved.
//
// Run: deno test --allow-env --allow-read --no-check supabase/functions/polya-coach/
import { assert, assertEquals } from "jsr:@std/assert@1";
import { authRoute, jsonResponse, loadHandler, rpcName, setBackend, TEST_USER_JWT } from "../_shared/test-serve.ts";

const handler = await loadHandler(new URL("./index.ts", import.meta.url).href);
const URL_ = "http://polya.test/functions/v1/polya-coach";
const COURSE_ID = "00000000-0000-4000-8000-0000000000c1";
const EXAM_ID = "00000000-0000-4000-8000-0000000000e1";
const CONV_ID = "00000000-0000-4000-8000-0000000000f1";
const TOPIC_A = "00000000-0000-4000-8000-0000000000a1";
const TOPIC_B = "00000000-0000-4000-8000-0000000000a2";
const QUESTION_ID = "00000000-0000-4000-8000-0000000000b1";

const EXAM = {
  id: EXAM_ID,
  course_id: COURSE_ID,
  title: "Midterm",
  exam_date: "2026-10-26",
  scope_note: "Lectures 1-20.",
  examples_note: null,
  plan: null,
};
const TOPICS = [
  { id: TOPIC_A, position: 0, title: "Chebyshev", summary: null, key_formulas: [], stage: null },
  { id: TOPIC_B, position: 1, title: "Indicators", summary: null, key_formulas: [], stage: null },
];
const SOURCES = [
  { id: "s1", title: "F26_midterm-practice1.pdf", status: "ready", origin: "canvas_file", source_kind: "pdf", content_role: "material" },
  { id: "s2", title: "Lec1.pdf", status: "ready", origin: "canvas_file", source_kind: "pdf", content_role: "material" },
];

type Block = { text: string } | { thinking: string } | { tool: string; input: unknown };

/** A streamed Claude reply made of the given blocks. */
function claudeStream(blocks: Block[], stop = "tool_use"): Response {
  const events: unknown[] = [{ type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 1 } } }];
  blocks.forEach((block, index) => {
    if ("text" in block) {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if ("thinking" in block) {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.thinking } });
    } else {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${index}`, name: block.tool, input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 200 } });
  events.push({ type: "message_stop" });
  const text = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
}

interface Options {
  hourly?: boolean;
  dailyTotal?: number;
  budget?: "allow" | "deny";
  exams?: unknown[];
  conversations?: unknown[];
  messageCount?: number;
  claude?: Response[];
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
    if (request.method === "HEAD") {
      calls.push({ what: `HEAD ${table}` });
      return new Response(null, { status: 200, headers: { "content-range": `*/${options.messageCount ?? 0}` } });
    }
    const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
    calls.push({ what: `${request.method} ${table}${request.method === "GET" ? url.search : ""}`, body });
    switch (`${request.method} ${table}`) {
      case "GET polya_exams":
        return jsonResponse(options.exams ?? [EXAM]);
      case "GET polya_conversations":
        return jsonResponse(options.conversations ?? []);
      case "GET polya_messages":
        return jsonResponse([]);
      case "GET polya_courses":
        return jsonResponse([{ name: "Stat 134" }]);
      case "GET polya_course_policies":
        return jsonResponse([]);
      case "GET polya_study_topics":
        return jsonResponse(TOPICS);
      case "GET polya_sources":
        return jsonResponse(SOURCES);
      case "GET polya_practice_attempts":
      case "GET polya_study_errors":
      case "GET polya_mock_exams":
      case "GET polya_exam_sources":
      case "GET polya_practice_questions":
        return jsonResponse([]);
      case "POST polya_conversations":
        return jsonResponse({ id: CONV_ID }, 201);
      case "POST polya_messages":
        return jsonResponse({ id: "00000000-0000-4000-8000-0000000000d1" }, 201);
      case "POST polya_practice_questions":
        return jsonResponse({ id: QUESTION_ID }, 201);
      case "POST polya_study_errors":
        return jsonResponse({ id: "00000000-0000-4000-8000-0000000000aa", created_at: "2026-10-20T00:00:00Z" }, 201);
      case "POST polya_practice_keys":
      case "POST polya_events":
      case "PATCH polya_conversations":
      case "PATCH polya_exams":
      case "PATCH polya_study_topics":
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

async function events(response: Response): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const event = chunk.match(/^event: (\w+)/)?.[1] ?? "";
      const data = JSON.parse(chunk.match(/data: (.*)$/m)?.[1] ?? "{}");
      return { event, data };
    });
}

const names = (calls: Call[]) => calls.map((c) => c.what.split("?")[0]);
const claudeBodies = (calls: Call[]) => calls.filter((c) => c.what === "claude").map((c) => c.body as Record<string, unknown>);

const VALID_QUESTION = {
  topics: [1, 2],
  hide_topic: true,
  difficulty: "exam_hard",
  stem: "X is integer-valued with mean 15 and variance 10.",
  parts: [
    { kind: "numeric", prompt: "Chebyshev bound on \\(P(X > 20)\\)?", answer_expr: "10/36", options: [], rubric: [], model_answer: "", points: 0 },
  ],
  explanation: "\\(P(X>20)=P(X\\ge 21)\\le 10/36\\).",
};

// --- guards ------------------------------------------------------------------

Deno.test("non-POST is 405; no session is a 401 that touches nothing", async () => {
  const calls = backend();
  const get = await handler(new Request(URL_, { method: "GET" }));
  assertEquals(get.status, 405);
  await get.body?.cancel();
  const anon = await handler(post({ exam_id: EXAM_ID, message: "hi" }, false));
  assertEquals(anon.status, 401);
  await anon.body?.cancel();
  assertEquals(calls, []);
});

Deno.test("bad shapes are 400s before any lookup", async () => {
  for (const body of [
    { exam_id: "nope", message: "hi" },
    { exam_id: EXAM_ID },
    { exam_id: EXAM_ID, message: "hi", event: { kind: "open" } },
    { exam_id: EXAM_ID, event: { kind: "attempt", attempt_id: "x" } },
  ]) {
    const calls = backend();
    const response = await handler(post(body));
    assertEquals(response.status, 400, JSON.stringify(body));
    await response.body?.cancel();
    assertEquals(names(calls), [], JSON.stringify(body));
  }
});

Deno.test("someone else's exam is a 404 before any cap or model call", async () => {
  const calls = backend({ exams: [] });
  const response = await handler(post({ exam_id: EXAM_ID, message: "hi" }));
  assertEquals(response.status, 404);
  await response.body?.cancel();
  assertEquals(names(calls), ["rpc claim_rate_limit", "GET polya_exams"]);
});

Deno.test("opening a coach that already has messages is refused", async () => {
  backend({ conversations: [{ id: CONV_ID }], messageCount: 4 });
  const response = await handler(post({ exam_id: EXAM_ID, event: { kind: "open" } }));
  assertEquals(response.status, 409);
  await response.body?.cancel();
});

Deno.test("the daily cap and the AI budget refuse before Claude is called", async () => {
  let calls = backend({ dailyTotal: 101 });
  let response = await handler(post({ exam_id: EXAM_ID, message: "hi" }));
  assertEquals(response.status, 429);
  await response.body?.cancel();
  assert(!names(calls).includes("claude"));

  calls = backend({ budget: "deny" });
  response = await handler(post({ exam_id: EXAM_ID, message: "hi" }));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).code, "busy");
  assert(!names(calls).includes("claude"));
});

// --- the tool loop --------------------------------------------------------------

Deno.test("an opening turn: inventory, then a plan and replies; thinking replayed unchanged", async () => {
  const calls = backend({
    claude: [
      claudeStream([{ thinking: "sig-1" }, { text: "Welcome! Here's what I found." }, { tool: "show_inventory", input: {} }]),
      claudeStream([
        { text: "Here's a plan for the next six days." },
        {
          tool: "save_plan",
          input: {
            days: [{ date: "2026-10-20", focus: "Chebyshev", tasks: [{ topic: 1, text: "Integer thresholds" }] }],
            note: "Weakest first.",
          },
        },
        { tool: "suggest_replies", input: { replies: ["Start with Chebyshev", "Show me the plan again"] } },
      ]),
    ],
  });
  const response = await handler(post({ exam_id: EXAM_ID, event: { kind: "open" }, client_today: "2026-10-20" }));
  assertEquals(response.status, 200);
  const stream = await events(response);
  assertEquals(stream[0]!.event, "sources");
  assertEquals(stream[0]!.data.conversation_id, CONV_ID);
  const blocks = stream.filter((e) => e.event === "block").map((e) => (e.data.block as { type: string }).type);
  assertEquals(blocks, ["inventory", "plan", "replies"]);
  assertEquals(stream.at(-1)!.event, "done");
  const text = stream.filter((e) => e.event === "delta").map((e) => e.data.text).join("");
  // Each call's text is its own segment, split by the block between them.
  assertEquals(text, "Welcome! Here's what I found.Here's a plan for the next six days.");

  const bodies = claudeBodies(calls);
  assertEquals(bodies.length, 2);
  assertEquals((bodies[0]!.tool_choice as { type: string }).type, "auto");
  const replay = bodies[1]!.messages as { role: string; content: unknown }[];
  const assistant = replay.at(-2)!;
  assertEquals(assistant.role, "assistant");
  assertEquals((assistant.content as unknown[])[0], { type: "thinking", thinking: "", signature: "sig-1" });
  const results = replay.at(-1)!.content as { type: string; tool_use_id: string; content: string }[];
  assertEquals(results[0]!.type, "tool_result");
  assertEquals(results[0]!.tool_use_id, "toolu_2");
  assert(results[0]!.content.includes("readable course files"));

  const plan = calls.find((c) => c.what === "PATCH polya_exams")!.body as { plan: { days: { items: { topic_id: string }[] }[] } };
  assertEquals(plan.plan.days[0]!.items[0]!.topic_id, TOPIC_A);
  const rows = calls.filter((c) => c.what === "POST polya_messages").map((c) => c.body as Record<string, unknown>);
  assertEquals(rows.map((r) => r.role), ["user", "assistant"]);
  assertEquals(rows[0]!.meta, { kind: "open" });
  assertEquals(
    (rows[1]!.blocks as { type: string; block?: { type: string } }[]).map((s) => s.block?.type ?? s.type),
    ["text", "inventory", "text", "plan", "replies"],
  );
  assert(String(rows[1]!.content).includes("[Saved a study plan: 2026-10-20 Chebyshev]"));
});

Deno.test("a practice question is checked, saved with its key server-side, and ends the turn", async () => {
  const calls = backend({
    conversations: [{ id: CONV_ID, exam_id: EXAM_ID }],
    claude: [claudeStream([{ text: "Try this one." }, { tool: "ask_question", input: VALID_QUESTION }])],
  });
  const response = await handler(post({ exam_id: EXAM_ID, conversation_id: CONV_ID, message: "quiz me" }));
  const stream = await events(response);
  const question = stream.find((e) => e.event === "block")!.data.block as { type: string; question: Record<string, unknown> };
  assertEquals(question.type, "question");
  assertEquals(question.question.id, QUESTION_ID);
  assertEquals(question.question.hide_topic, true);
  assertEquals("topic_ids" in question.question, false);
  assert(!JSON.stringify(stream).includes("10/36"), "the key never reaches the student");

  assertEquals(claudeBodies(calls).length, 1);
  const saved = calls.find((c) => c.what === "POST polya_practice_questions")!.body as Record<string, unknown>;
  assertEquals(saved.origin, "coach");
  assertEquals(saved.topic_ids, [TOPIC_A, TOPIC_B]);
  assertEquals(saved.difficulty, 3);
  const key = calls.find((c) => c.what === "POST polya_practice_keys")!.body as { answers: unknown[] };
  assertEquals(key.answers, [{ kind: "numeric", expr: "10/36", value: 10 / 36 }]);
  const assistant = calls.filter((c) => c.what === "POST polya_messages").map((c) => c.body as Record<string, unknown>)[1]!;
  assert(!JSON.stringify(assistant).includes("10/36"), "stored rows carry no key");
});

Deno.test("a question that fails its check goes back to the model as an error, not to the student", async () => {
  const bad = structuredClone(VALID_QUESTION);
  bad.parts[0]!.answer_expr = "roughly 0.28";
  const calls = backend({
    conversations: [{ id: CONV_ID, exam_id: EXAM_ID }],
    claude: [
      claudeStream([{ tool: "ask_question", input: bad }]),
      claudeStream([{ tool: "ask_question", input: VALID_QUESTION }]),
    ],
  });
  const response = await handler(post({ exam_id: EXAM_ID, conversation_id: CONV_ID, message: "quiz me" }));
  const stream = await events(response);
  assertEquals(stream.filter((e) => e.event === "block").length, 1);
  const bodies = claudeBodies(calls);
  assertEquals(bodies.length, 2);
  const result = ((bodies[1]!.messages as { content: unknown }[]).at(-1)!.content as { is_error?: boolean; content: string }[])[0]!;
  assertEquals(result.is_error, true);
  assert(result.content.includes("calculator expression"));
  assertEquals(calls.filter((c) => c.what === "POST polya_practice_questions").length, 1);
});

Deno.test("a refusal or a failed first call saves nothing and says so", async () => {
  const calls = backend({ claude: [jsonResponse({ type: "error" }, 529)] });
  const response = await handler(post({ exam_id: EXAM_ID, message: "hi" }));
  const stream = await events(response);
  const error = stream.find((e) => e.event === "error")!;
  assertEquals(error.data.code, "busy");
  assertEquals(calls.filter((c) => c.what === "POST polya_messages").length, 0);
});
