// polya-coach — the exam coach over SSE.
//
// One conversation per exam. Each turn the coach sees a picture of the exam
// (topics with their stage and recent accuracy, open mistakes, the plan, what's
// due for review, the course inventory) plus course evidence, and answers the
// student's message or what the student just did (opened the coach, answered a
// practice question, handed in a mock exam). It can call tools: search the
// course, show the inventory, put a practice question in front of the student,
// record a topic's stage, log a mistake, save the plan, suggest replies, set
// up a mock exam. Every tool runs here, after its input is checked
// (_shared/coach-tools.ts); a question's key is checked by fixed rules and
// never leaves the server.
//
// Flow: POST only -> body cap -> auth -> shape -> hourly window -> ownership of
// every id -> event dedupe -> daily cap -> budgets (all fail closed) -> load the
// exam -> retrieve -> stream up to COACH_MAX_CALLS model calls, running tools
// between them -> persist both rows -> done.
//
// SSE events: sources {sources, conversation_id, policy_mode} (first, and again
// after a course search; numbering only ever grows) · status {state} ·
// delta {text} · block {block} · error {error, code} · done {message_id, usage}.
import { corsHeaders, json } from "../_shared/cors.ts";
import { createUserClient, HttpError, requireAuthUser } from "../_shared/auth-user.ts";
import { service } from "../_shared/service.ts";
import { trackServer } from "../_shared/events.ts";
import { readJsonCapped } from "../_shared/read-json-capped.ts";
import { checkTutorMessage, TUTOR_MESSAGE_MAX_CHARS } from "../_shared/tutor-limits.ts";
import { claimRateLimit, rateLimitedResponse, withinDailyCap } from "../_shared/rate-limit.ts";
import {
  COACH_DAILY_BUCKET,
  COACH_DAILY_LIMIT,
  COACH_HOURLY_BUCKET,
  COACH_HOURLY_LIMIT,
  COACH_MAX_BODY_BYTES,
  COACH_MOCK_DAILY_BUCKET,
  COACH_MOCK_DAILY_LIMIT,
  HOUR_SECONDS,
} from "../_shared/polya-rate-limits.ts";
import {
  aiBusyResponse,
  AI_BUSY_MESSAGE,
  claimAiBudget,
  estimateEmbeddingUnits,
  estimateModelUnits,
} from "../_shared/ai-budget.ts";
import { retrieve } from "../_shared/retrieval.ts";
import { buildSources, evidenceBlock, type EvidenceSource, type PolicyMode } from "../_shared/prompts.ts";
import { addUsage, readSse, TurnAccumulator, ZERO_USAGE, type StreamUsage } from "../_shared/anthropic-stream.ts";
import { COACH_TOOLS, decideNext, TOOL_KIND, validateToolInput, type ToolContext, type ToolInput, type ToolName } from "../_shared/coach-tools.ts";
import {
  attemptEventText,
  buildCoachSystemBlocks,
  buildCoachUserTurn,
  examStateBlock,
  flattenHistory,
  mockEventText,
  OPEN_EVENT_TEXT,
  type StateTopic,
} from "../_shared/coach-prompts.ts";
import {
  asPlan,
  blockSummary,
  eventContent,
  type CoachBlock,
  type CoachSegment,
  type EventMeta,
  type StudyPlan,
} from "../_shared/coach-blocks.ts";
import {
  canMarkExamReady,
  dueReviews,
  errorStatus,
  stagesByTopic,
  type ProgressAttempt,
} from "../_shared/study-progress.ts";
import { buildInventory, inventorySummary, type InventorySource } from "../_shared/study-inventory.ts";
import type { PartKey, PartResponse, PartResult } from "../_shared/study-grade.ts";
import type { PublicPart } from "../_shared/study-questions.ts";
import type { MockReport } from "../_shared/study-mock.ts";

// claude-sonnet-5 has a row in ai-budget.ts MODEL_PRICES (a file that must stay
// byte-identical across three repos), so budget estimates are exact.
const COACH_MODEL = "claude-sonnet-5";
const COACH_MAX_TOKENS = 8_000; // thinking counts against it
const COACH_EFFORT = "medium"; // pinned: changing it would invalidate the cache
const COACH_MAX_CALLS = 3;
const COACH_MAX_SEARCHES = 2;
const HISTORY_ROWS = 12;
// The edge function's wall clock is 150 s (Free plan). Leave room to persist.
const TURN_DEADLINE_MS = 110_000;
const CALL_TIMEOUT_MS = 85_000;
const MIN_CALL_MS = 20_000;
const ANTHROPIC_KEY = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } })
  .Deno?.env.get("ANTHROPIC_API_KEY") ?? "";

const UNAVAILABLE = "Polya couldn't answer just now. Please try again in a moment.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type CoachEvent =
  | { kind: "open" }
  | { kind: "attempt"; attempt_id: string }
  | { kind: "mock_submitted"; mock_id: string };

interface CoachBody {
  exam_id?: unknown;
  conversation_id?: unknown;
  client_today?: unknown;
  message?: unknown;
  event?: unknown;
}

interface ExamRow {
  id: string;
  course_id: string;
  title: string;
  exam_date: string | null;
  scope_note: string | null;
  examples_note: string | null;
  plan: unknown;
}

interface TopicRow {
  id: string;
  position: number;
  title: string;
  summary: string | null;
  key_formulas: string[];
  stage: string | null;
}

interface AttemptRow extends ProgressAttempt {
  id: string;
}

const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);

function readEvent(raw: unknown): CoachEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.kind === "open") return { kind: "open" };
  if (e.kind === "attempt" && isUuid(e.attempt_id)) return { kind: "attempt", attempt_id: e.attempt_id };
  if (e.kind === "mock_submitted" && isUuid(e.mock_id)) return { kind: "mock_submitted", mock_id: e.mock_id };
  return null;
}

/** The student's calendar date if it's within a day of UTC's (time zones), else UTC's. */
function studentToday(raw: unknown, now = new Date()): string {
  const utc = now.toISOString().slice(0, 10);
  if (typeof raw !== "string" || !DATE_RE.test(raw)) return utc;
  const diff = Math.abs(Date.parse(`${raw}T00:00:00Z`) - Date.parse(`${utc}T00:00:00Z`));
  return diff <= 86_400_000 ? raw : utc;
}

function httpErrorResponse(error: HttpError): Response {
  const code = error.status === 401
    ? "unauthorized"
    : error.status === 404
    ? "not_found"
    : error.status === 409
    ? "conflict"
    : error.status === 413
    ? "too_long"
    : "bad_request";
  return json({ error: error.message, code }, error.status);
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed.", code: "method_not_allowed" }, 405);

  const parsed = await readJsonCapped<CoachBody>(request, COACH_MAX_BODY_BYTES);
  if (!parsed.ok) {
    return parsed.status === 413
      ? json({ error: "That message is too long.", code: "too_long" }, 413)
      : json({ error: "Something went wrong sending that. Please try again.", code: "bad_request" }, 400);
  }
  const body = parsed.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Something went wrong sending that. Please try again.", code: "bad_request" }, 400);
  }

  try {
    const user = await requireAuthUser(request);
    return await handleTurn(request, user.id, body);
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 401) return json({ error: "Please sign in again.", code: "unauthorized" }, 401);
      return httpErrorResponse(error);
    }
    console.error("[polya-coach] error:", error);
    return json({ error: UNAVAILABLE, code: "internal" }, 500);
  }
});

async function handleTurn(request: Request, userId: string, body: CoachBody): Promise<Response> {
  // --- shape -------------------------------------------------------------------
  if (!isUuid(body.exam_id)) throw new HttpError("Missing or invalid exam.", 400);
  if (body.conversation_id !== undefined && body.conversation_id !== null && !isUuid(body.conversation_id)) {
    throw new HttpError("Missing or invalid conversation.", 400);
  }
  const event = body.event === undefined || body.event === null ? null : readEvent(body.event);
  if (body.event !== undefined && body.event !== null && !event) throw new HttpError("That action isn't recognized.", 400);
  let message: string | null = null;
  if (!event) {
    const check = checkTutorMessage(body.message);
    if (check === "missing") throw new HttpError("Missing message.", 400);
    if (check === "too_long") {
      throw new HttpError(`That message is too long. Please keep it under ${TUTOR_MESSAGE_MAX_CHARS.toLocaleString("en-US")} characters.`, 413);
    }
    message = (body.message as string).trim();
  } else if (body.message !== undefined && body.message !== null) {
    throw new HttpError("Send a message or an action, not both.", 400);
  }
  const today = studentToday(body.client_today);

  // --- hourly window (keyed on the user alone, so it runs before any lookup) --
  if (!(await claimRateLimit(service, `user:${userId}`, COACH_HOURLY_BUCKET, COACH_HOURLY_LIMIT, HOUR_SECONDS))) {
    return rateLimitedResponse({
      message: "You're going quickly. Take a short break and try again in a little while.",
      headers: corsHeaders,
    });
  }

  // --- ownership ---------------------------------------------------------------
  const { data: examData } = await service
    .from("polya_exams")
    .select("id, course_id, title, exam_date, scope_note, examples_note, plan")
    .eq("id", body.exam_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!examData) throw new HttpError("That exam isn't available.", 404);
  const exam = examData as ExamRow;

  let conversationId: string | null = null;
  if (isUuid(body.conversation_id)) {
    const { data } = await service
      .from("polya_conversations")
      .select("id, exam_id")
      .eq("id", body.conversation_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!data || data.exam_id !== exam.id) throw new HttpError("That conversation isn't available.", 404);
    conversationId = data.id as string;
  } else {
    const { data } = await service
      .from("polya_conversations")
      .select("id")
      .eq("exam_id", exam.id)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    conversationId = (data?.id as string | undefined) ?? null;
  }

  const target = await loadEventTarget(userId, exam, event, conversationId);

  // --- daily cap, then budgets (all fail closed) -------------------------------
  if (!(await withinDailyCap(service, userId, COACH_DAILY_BUCKET, COACH_DAILY_LIMIT))) {
    return rateLimitedResponse({ message: "You've reached today's coaching limit. It resets tomorrow.", headers: corsHeaders });
  }

  const context = await loadContext(userId, exam, conversationId, today, target);
  const retrievalQuery = (message ?? target.query ?? exam.title).slice(0, 1_500);
  if ((await claimAiBudget(service, "gemini", userId, estimateEmbeddingUnits(retrievalQuery.length))) !== "ok") {
    return aiBusyResponse({ headers: corsHeaders });
  }
  const userClient = createUserClient(request);
  const excludeRoles = context.mode === "practice" ? ["solution_key"] : [];
  const units = await retrieve(userClient, exam.course_id, retrievalQuery, excludeRoles);
  const sources: EvidenceSource[] = buildSources(units);

  const systemBlocks = buildCoachSystemBlocks(context.courseName, context.mode, context.studyNote);
  const userTurn = buildCoachUserTurn({
    examState: context.examState,
    evidence: evidenceBlock(sources, units),
    message: message ?? undefined,
    eventText: target.eventText ?? undefined,
  });
  const messages: unknown[] = [
    ...context.history,
    { role: "user", content: [{ type: "text", text: userTurn, cache_control: { type: "ephemeral" } }] },
  ];
  const firstBody = requestBody(systemBlocks, messages, false);
  if ((await claimModelBudget(userId, firstBody)) !== "ok") return aiBusyResponse({ headers: corsHeaders });

  if (!conversationId) {
    const { data, error } = await service
      .from("polya_conversations")
      .insert({ user_id: userId, course_id: exam.course_id, exam_id: exam.id, title: exam.title.slice(0, 60) })
      .select("id")
      .single();
    if (error || !data) throw new Error(`conversation create failed: ${error?.message}`);
    conversationId = data.id as string;
  }

  return streamTurn({
    userId,
    exam,
    conversationId,
    today,
    mode: context.mode,
    systemBlocks,
    messages,
    sources,
    excludeRoles,
    userClient,
    context,
    studentMessage: message,
    eventMeta: target.meta,
    eventIds: target.ids,
  });
}

// ---------------------------------------------------------------------------
// What the student just did: ownership, dedupe, and how to describe it.
// ---------------------------------------------------------------------------
interface EventTarget {
  meta: EventMeta | null;
  eventText: string | null;
  query: string | null;
  ids: { questionId: string | null; attemptId: string | null };
  /** Attempt events: the topics the question covered, by id. */
  topicIds: string[];
  hiddenTopic: boolean;
  attempt?: {
    stem: string;
    parts: PublicPart[];
    keys: PartKey[];
    responses: PartResponse[];
    results: PartResult[];
    explanation: string;
  };
  mock?: { title: string; minutes: number; report: MockReport };
}

const NO_TARGET: EventTarget = { meta: null, eventText: null, query: null, ids: { questionId: null, attemptId: null }, topicIds: [], hiddenTopic: false };

async function alreadyDiscussed(conversationId: string | null, key: string, id: string): Promise<boolean> {
  if (!conversationId) return false;
  const { data } = await service
    .from("polya_messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq(`meta->>${key}`, id)
    .limit(1);
  return (data ?? []).length > 0;
}

async function loadEventTarget(
  userId: string,
  exam: ExamRow,
  event: CoachEvent | null,
  conversationId: string | null,
): Promise<EventTarget> {
  if (!event) return NO_TARGET;
  if (event.kind === "open") {
    if (conversationId) {
      const { count } = await service
        .from("polya_messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", conversationId);
      if ((count ?? 0) > 0) throw new HttpError("This exam's coach is already open.", 409);
    }
    return { ...NO_TARGET, meta: { kind: "open" }, eventText: OPEN_EVENT_TEXT };
  }

  if (event.kind === "attempt") {
    const { data: attempt } = await service
      .from("polya_practice_attempts")
      .select("id, question_id, exam_id, responses, results, score, all_correct, mock_id")
      .eq("id", event.attempt_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!attempt || attempt.exam_id !== exam.id || attempt.mock_id) throw new HttpError("That answer isn't available.", 404);
    if (await alreadyDiscussed(conversationId, "attempt_id", attempt.id as string)) {
      throw new HttpError("Polya already went over that answer.", 409);
    }
    const [{ data: question }, { data: key }] = await Promise.all([
      service
        .from("polya_practice_questions")
        .select("id, stem, parts, topic_id, topic_ids, hide_topic")
        .eq("id", attempt.question_id)
        .eq("user_id", userId)
        .maybeSingle(),
      service
        .from("polya_practice_keys")
        .select("answers, explanation")
        .eq("question_id", attempt.question_id)
        .eq("user_id", userId)
        .maybeSingle(),
    ]);
    if (!question || !key) throw new HttpError("That answer isn't available.", 404);
    const parts = question.parts as PublicPart[];
    const results = attempt.results as PartResult[];
    const right = results.filter((r) => r.ok && r.correct).length;
    const meta: EventMeta = {
      kind: "attempt",
      attempt_id: attempt.id as string,
      question_id: question.id as string,
      right,
      total: parts.length,
    };
    if (parts.some((p) => p.kind === "free_response")) {
      meta.possible = parts.reduce((sum, p) => sum + (p.kind === "free_response" ? p.points : 1), 0);
      meta.earned = results.reduce(
        (sum, r) => sum + (!r.ok ? 0 : typeof r.awarded === "number" ? r.awarded : r.correct ? 1 : 0),
        0,
      );
    }
    const topicIds = (question.topic_ids as string[] | null)?.length ? (question.topic_ids as string[]) : [question.topic_id as string];
    return {
      meta,
      eventText: null, // built once topic numbers are known (loadContext)
      query: question.stem as string,
      ids: { questionId: question.id as string, attemptId: attempt.id as string },
      topicIds,
      hiddenTopic: question.hide_topic === true,
      attempt: {
        stem: question.stem as string,
        parts,
        keys: key.answers as PartKey[],
        responses: attempt.responses as PartResponse[],
        results,
        explanation: key.explanation as string,
      },
    };
  }

  const { data: mock } = await service
    .from("polya_mock_exams")
    .select("id, exam_id, title, minutes, status, report")
    .eq("id", event.mock_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!mock || mock.exam_id !== exam.id || mock.status !== "submitted" || !mock.report) {
    throw new HttpError("That mock exam isn't available.", 404);
  }
  if (await alreadyDiscussed(conversationId, "mock_id", mock.id as string)) {
    throw new HttpError("Polya already went over that mock exam.", 409);
  }
  const report = mock.report as MockReport;
  return {
    ...NO_TARGET,
    meta: { kind: "mock_submitted", mock_id: mock.id as string, title: mock.title as string, pct: Math.round(report.score * 100) },
    query: report.per_topic.slice(0, 3).map((t) => t.title).join(" "),
    mock: { title: mock.title as string, minutes: mock.minutes as number, report },
  };
}

// ---------------------------------------------------------------------------
// The exam picture.
// ---------------------------------------------------------------------------
interface CoachContext {
  courseName: string;
  mode: PolicyMode;
  studyNote: string | null;
  topics: TopicRow[];
  topicNumber: Map<string, number>;
  attempts: AttemptRow[];
  plan: StudyPlan | null;
  inventory: ReturnType<typeof buildInventory>;
  examState: string;
  history: { role: "user" | "assistant"; content: string }[];
  progressReady: (topicId: string) => boolean;
}

async function loadContext(
  userId: string,
  exam: ExamRow,
  conversationId: string | null,
  today: string,
  target: EventTarget,
): Promise<CoachContext> {
  const [course, policy, topics, attempts, errors, mocks, sources, marks, historyRows] = await Promise.all([
    service.from("polya_courses").select("name").eq("id", exam.course_id).eq("user_id", userId).maybeSingle(),
    service.from("polya_course_policies").select("mode, instructor_note").eq("course_id", exam.course_id).eq("user_id", userId).maybeSingle(),
    service
      .from("polya_study_topics")
      .select("id, position, title, summary, key_formulas, stage")
      .eq("exam_id", exam.id)
      .eq("user_id", userId)
      .order("position", { ascending: true }),
    service
      .from("polya_practice_attempts")
      .select("id, question_id, topic_id, topic_ids, score, all_correct, created_at")
      .eq("exam_id", exam.id)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      // Same rows as the exam page, so the exam-ready gate matches what the student sees.
      .limit(2_000),
    service
      .from("polya_study_errors")
      .select("id, topic_id, what, why, fix, created_at")
      .eq("exam_id", exam.id)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(30),
    service
      .from("polya_mock_exams")
      .select("title, status, score")
      .eq("exam_id", exam.id)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(3),
    service
      .from("polya_sources")
      .select("id, title, status, origin, source_kind, content_role, module_name, folder_path")
      .eq("course_id", exam.course_id)
      .eq("user_id", userId)
      .limit(500),
    service.from("polya_exam_sources").select("kind, source_id, source:polya_sources(title)").eq("exam_id", exam.id).eq("user_id", userId),
    conversationId
      ? service
        .from("polya_messages")
        .select("role, content")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(HISTORY_ROWS)
      : Promise.resolve({ data: [] }),
  ]);

  const topicRows = (topics.data ?? []) as TopicRow[];
  const attemptRows = (attempts.data ?? []) as AttemptRow[];
  const now = Date.now();
  const stages = stagesByTopic(topicRows, attemptRows, now);
  const topicNumber = new Map(topicRows.map((t, i) => [t.id, i + 1]));
  const numberOf = (id: string | null) => (id ? topicNumber.get(id) ?? null : null);

  const markRows = (marks.data ?? []) as unknown as { kind: string; source_id: string; source: { title: string } | null }[];
  const inventory = buildInventory((sources.data ?? []) as InventorySource[], markRows);
  const openErrors = errorStatus((errors.data ?? []) as { id: string; topic_id: string | null; what: string; why: string; fix: string; created_at: string }[], attemptRows)
    .filter((e) => !e.fixed)
    .slice(0, 10);
  const due = dueReviews({ topics: topicRows, attempts: attemptRows, now });
  let dueQuestions: { stem: string; topicN: number | null }[] = [];
  if (due.questionIds.length > 0) {
    const { data } = await service
      .from("polya_practice_questions")
      .select("id, stem, topic_id")
      .in("id", due.questionIds)
      .eq("user_id", userId);
    dueQuestions = ((data ?? []) as { stem: string; topic_id: string }[]).map((q) => ({ stem: q.stem, topicN: numberOf(q.topic_id) }));
  }
  const plan = asPlan(exam.plan);

  const stateTopics: StateTopic[] = topicRows.map((t, i) => {
    const info = stages.get(t.id)!;
    return {
      n: i + 1,
      title: t.title,
      summary: t.summary,
      key_formulas: t.key_formulas ?? [],
      stage: info.stage,
      accuracy: info.progress.accuracy,
      attempts: info.progress.attempts,
      firstTries: info.progress.firstTries,
      lastAttemptAt: info.lastAttemptAt,
    };
  });
  const examState = examStateBlock({
    exam: { title: exam.title, examDate: exam.exam_date, scopeNote: exam.scope_note, examplesNote: exam.examples_note },
    today,
    topics: stateTopics,
    openErrors: openErrors.map((e, i) => ({ n: i + 1, topicN: numberOf(e.topic_id), what: e.what, why: e.why, fix: e.fix })),
    plan,
    due: { topicNs: due.topicIds.map((id) => topicNumber.get(id)!).filter(Boolean), questions: dueQuestions },
    mocks: ((mocks.data ?? []) as { title: string; status: string; score: number | null }[]),
    inventory: inventorySummary(inventory),
    markedFiles: {
      formulaSheets: markRows.filter((m) => m.kind === "formula_sheet").map((m) => m.source?.title ?? "").filter(Boolean),
      pastExams: markRows.filter((m) => m.kind === "past_exam").map((m) => m.source?.title ?? "").filter(Boolean),
    },
  });

  // Event text needs topic numbers, which exist only now.
  if (target.attempt) {
    target.eventText = attemptEventText({
      ...target.attempt,
      topicNs: target.topicIds.map((id) => topicNumber.get(id)).filter((n): n is number => typeof n === "number"),
      hiddenTopic: target.hiddenTopic,
    });
  } else if (target.mock) {
    const { report } = target.mock;
    target.eventText = mockEventText({
      title: target.mock.title,
      minutes: target.mock.minutes,
      minutesUsed: report.minutes_used,
      overtimeSeconds: report.overtime_seconds,
      score: report.score,
      perTopic: report.per_topic.map((t) => ({ topicN: numberOf(t.topic_id), title: t.title, earned: t.earned, possible: t.possible })),
      missed: await missedDetails(userId, report.missed.slice(0, 6), numberOf),
    });
  }

  const historyData = ((historyRows as { data: unknown }).data ?? []) as { role: string; content: string }[];
  const mode = ((policy.data as { mode?: string } | null)?.mode ?? "guided") as PolicyMode;
  return {
    courseName: ((course.data as { name?: string } | null)?.name) ?? "your course",
    mode,
    studyNote: (policy.data as { instructor_note?: string | null } | null)?.instructor_note ?? null,
    topics: topicRows,
    topicNumber,
    attempts: attemptRows,
    plan,
    inventory,
    examState,
    history: flattenHistory([...historyData].reverse()),
    progressReady: (topicId) => {
      const info = stages.get(topicId);
      return info ? canMarkExamReady(info.progress) : false;
    },
  };
}

/** For a handed-in mock: what the student answered on each missed question, against the key. */
async function missedDetails(
  userId: string,
  questionIds: readonly string[],
  numberOf: (id: string | null) => number | null,
): Promise<{ stem: string; topicN: number | null; detail: string }[]> {
  if (questionIds.length === 0) return [];
  const [{ data: questions }, { data: keys }, { data: attempts }] = await Promise.all([
    service.from("polya_practice_questions").select("id, stem, parts, topic_id").in("id", questionIds as string[]).eq("user_id", userId),
    service.from("polya_practice_keys").select("question_id, answers").in("question_id", questionIds as string[]).eq("user_id", userId),
    service
      .from("polya_practice_attempts")
      .select("question_id, responses, results")
      .in("question_id", questionIds as string[])
      .eq("user_id", userId)
      .not("mock_id", "is", null),
  ]);
  const keyBy = new Map(((keys ?? []) as { question_id: string; answers: PartKey[] }[]).map((k) => [k.question_id, k.answers]));
  const attemptBy = new Map(((attempts ?? []) as { question_id: string; responses: PartResponse[]; results: PartResult[] }[]).map((a) => [a.question_id, a]));
  return ((questions ?? []) as { id: string; stem: string; parts: PublicPart[]; topic_id: string }[]).map((q) => {
    const keysFor = keyBy.get(q.id) ?? [];
    const attempt = attemptBy.get(q.id);
    const detail = q.parts
      .map((part, i) => {
        const result = attempt?.results[i];
        if (result?.ok && result.correct) return null;
        const key = keysFor[i];
        const response = attempt?.responses[i];
        const answered = !response
          ? "blank"
          : response.kind === "numeric"
          ? response.answer || "blank"
          : response.kind === "mc"
          ? (response.choice >= 0 ? "ABCDEF"[response.choice] : "blank")
          : response.kind === "select_all"
          ? response.choices.map((c) => "ABCDEF"[c]).join(", ") || "none"
          : response.text.slice(0, 300) || "blank";
        const expected = !key
          ? "?"
          : key.kind === "numeric"
          ? key.expr
          : key.kind === "mc"
          ? "ABCDEF"[key.correct]
          : key.kind === "select_all"
          ? key.correct.map((c) => "ABCDEF"[c]).join(", ") || "none"
          : `rubric: ${key.rubric.join("; ")}`;
        const points = result?.ok && typeof result.awarded === "number" ? ` (${result.awarded}/${result.points} points)` : "";
        return `Part ${i + 1}: answered ${answered}; key ${expected}${points}`;
      })
      .filter(Boolean)
      .join(" | ");
    return { stem: q.stem, topicN: numberOf(q.topic_id), detail };
  });
}

// ---------------------------------------------------------------------------
// Model calls.
// ---------------------------------------------------------------------------
function requestBody(systemBlocks: unknown[], messages: unknown[], last: boolean): Record<string, unknown> {
  return {
    model: COACH_MODEL,
    max_tokens: COACH_MAX_TOKENS,
    stream: true,
    tools: COACH_TOOLS,
    tool_choice: { type: last ? "none" : "auto" },
    output_config: { effort: COACH_EFFORT },
    system: systemBlocks,
    messages,
  };
}

async function claimModelBudget(userId: string, body: Record<string, unknown>) {
  const inputChars = JSON.stringify({ system: body.system, tools: body.tools, messages: body.messages }).length;
  return await claimAiBudget(service, "anthropic", userId, estimateModelUnits(COACH_MODEL, inputChars, COACH_MAX_TOKENS));
}

interface TurnArgs {
  userId: string;
  exam: ExamRow;
  conversationId: string;
  today: string;
  mode: PolicyMode;
  systemBlocks: unknown[];
  messages: unknown[];
  sources: EvidenceSource[];
  excludeRoles: string[];
  userClient: ReturnType<typeof createUserClient>;
  context: CoachContext;
  studentMessage: string | null;
  eventMeta: EventMeta | null;
  eventIds: { questionId: string | null; attemptId: string | null };
}

function streamTurn(args: TurnArgs): Response {
  const encoder = new TextEncoder();
  let open = true;

  const stream = new ReadableStream({
    async start(controller) {
      // The student may close the page mid-turn; keep working so the turn (and
      // any question already written) is still saved.
      const send = (event: string, data: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          open = false;
        }
      };

      const started = Date.now();
      const sources = [...args.sources];
      const segments: CoachSegment[] = [];
      const toolsUsed: string[] = [];
      let usage: StreamUsage = ZERO_USAGE;
      let searches = 0;
      let calls = 0;
      let failure: { error: string; code: string } | null = null;
      let newTextBlock = false;

      const pushText = (text: string) => {
        if (!text) return;
        const last = segments[segments.length - 1];
        if (last?.type === "text") {
          const joined = newTextBlock && last.text && !/\s$/.test(last.text) ? `\n\n${text}` : text;
          last.text += joined;
          send("delta", { text: joined });
        } else {
          segments.push({ type: "text", text });
          send("delta", { text });
        }
        newTextBlock = false;
      };
      const pushBlock = (block: CoachBlock) => {
        segments.push({ type: "block", block });
        send("block", { block });
      };

      send("sources", { sources, conversation_id: args.conversationId, policy_mode: args.mode });

      const toolCtx = (): ToolContext => ({
        topics: args.context.topics.map((t, i) => ({ n: i + 1, id: t.id, title: t.title })),
        today: args.today,
        examDate: args.exam.exam_date,
        sourceCount: sources.length,
        canMarkExamReady: args.context.progressReady,
        newId: () => crypto.randomUUID(),
      });

      try {
        for (let callIndex = 0; callIndex < COACH_MAX_CALLS; callIndex++) {
          const elapsed = Date.now() - started;
          if (callIndex > 0 && TURN_DEADLINE_MS - elapsed < MIN_CALL_MS) break;
          const last = callIndex === COACH_MAX_CALLS - 1;
          const body = requestBody(args.systemBlocks, args.messages, last);
          if (callIndex > 0 && (await claimModelBudget(args.userId, body)) !== "ok") {
            failure = { error: AI_BUSY_MESSAGE, code: "busy" };
            break;
          }

          const abort = new AbortController();
          const timer = setTimeout(() => abort.abort(), Math.min(CALL_TIMEOUT_MS, TURN_DEADLINE_MS - elapsed));
          calls++;
          const accumulator = new TurnAccumulator();
          newTextBlock = callIndex > 0;
          try {
            const response = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              signal: abort.signal,
              headers: {
                "x-api-key": ANTHROPIC_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            });
            if (!response.ok || !response.body) {
              const detail = await response.text().catch(() => "");
              console.error("[polya-coach] anthropic error:", response.status, detail.slice(0, 300));
              failure = { error: response.status === 529 || response.status === 429 ? AI_BUSY_MESSAGE : UNAVAILABLE, code: response.status === 529 || response.status === 429 ? "busy" : "unavailable" };
              break;
            }
            for await (const event of readSse(response.body)) {
              const out = accumulator.onEvent(event);
              if (out.text) pushText(out.text);
              if (out.toolStarted) {
                send("status", { state: out.toolStarted === "ask_question" ? "writing_question" : out.toolStarted === "search_course" ? "searching" : "working" });
              }
            }
          } catch (error) {
            const timedOut = abort.signal.aborted;
            console.error(`[polya-coach] call ${callIndex + 1} failed${timedOut ? " (timeout)" : ""}:`, error);
            failure = timedOut
              ? { error: "That took longer than expected. Please try again.", code: "slow" }
              : { error: UNAVAILABLE, code: "unavailable" };
            break;
          } finally {
            clearTimeout(timer);
          }

          const result = accumulator.result();
          usage = addUsage(usage, result.usage);
          if (result.error) {
            console.error("[polya-coach] stream error event:", result.error);
            failure = { error: UNAVAILABLE, code: "unavailable" };
            break;
          }
          if (result.stopReason === "refusal") {
            failure = { error: "Polya couldn't help with that one. Try asking it a different way.", code: "declined" };
            break;
          }
          // A reply cut off mid tool call: never run a half-written tool.
          if (result.stopReason === "max_tokens" && result.toolUses.length > 0) break;

          const outcomes: { name: string; ok: boolean }[] = [];
          const toolResults: unknown[] = [];
          for (const use of result.toolUses) {
            toolsUsed.push(use.name);
            const ran = await runTool(use, args, toolCtx(), sources, {
              searchesLeft: COACH_MAX_SEARCHES - searches,
              onSearch: () => searches++,
              pushBlock,
              send,
              last,
            });
            outcomes.push({ name: use.name, ok: ran.ok });
            toolResults.push({
              type: "tool_result",
              tool_use_id: use.id,
              content: ran.content,
              ...(ran.ok ? {} : { is_error: true }),
            });
          }

          const turnHasText = segments.some((s) => s.type === "text" && s.text.trim());
          const next = decideNext({ stopReason: result.stopReason, outcomes, callIndex, maxCalls: COACH_MAX_CALLS, turnHasText });
          if (next === "end") break;
          args.messages.push({ role: "assistant", content: result.content });
          args.messages.push({ role: "user", content: toolResults });
        }
      } catch (error) {
        console.error("[polya-coach] turn failed:", error);
        failure = { error: UNAVAILABLE, code: "unavailable" };
      }

      // Save whatever the student saw. A turn that produced nothing is not
      // saved, so the student (or the page) can simply try again.
      let messageId: string | null = null;
      if (segments.length > 0) {
        messageId = await persist(args, segments, sources, usage, { calls, tools: toolsUsed, failed: failure?.code ?? null });
      }
      await trackServer(args.userId, "coach_turn", args.exam.course_id, {
        kind: args.eventMeta?.kind ?? "message",
        calls,
        tools: toolsUsed,
        failed: failure?.code ?? null,
        input_tokens: usage.input_tokens,
        cache_read_tokens: usage.cache_read_input_tokens,
      });
      if (failure) send("error", failure);
      send("done", { message_id: messageId, usage });
      if (open) {
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      }
    },
    cancel() {
      open = false;
    },
  });

  return new Response(stream, {
    headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

// ---------------------------------------------------------------------------
// Tools.
// ---------------------------------------------------------------------------
interface RunHooks {
  searchesLeft: number;
  onSearch: () => void;
  pushBlock: (block: CoachBlock) => void;
  send: (event: string, data: unknown) => void;
  last: boolean;
}

type Ran = { ok: boolean; content: string };

async function runTool(
  use: { id: string; name: string; input: Record<string, unknown> | null; raw: string },
  args: TurnArgs,
  ctx: ToolContext,
  sources: EvidenceSource[],
  hooks: RunHooks,
): Promise<Ran> {
  if (use.input === null) {
    return { ok: false, content: JSON.stringify({ INVALID_JSON: use.raw.slice(0, 2_000) }) };
  }
  const checked = validateToolInput(use.name, use.input, ctx);
  if (!checked.ok) return { ok: false, content: checked.error };
  // A data tool on the last call has no next call to read its result.
  if (hooks.last && TOOL_KIND[use.name as ToolName] === "data") return { ok: false, content: "No more lookups this turn." };
  try {
    return await execute(checked.value, args, sources, hooks);
  } catch (error) {
    console.error(`[polya-coach] tool ${use.name} failed:`, error);
    return { ok: false, content: "That didn't work just now. Carry on without it." };
  }
}

async function execute(input: ToolInput, args: TurnArgs, sources: EvidenceSource[], hooks: RunHooks): Promise<Ran> {
  const { userId, exam } = args;
  switch (input.name) {
    case "search_course": {
      if (hooks.searchesLeft <= 0) return { ok: false, content: "No more searches this turn; teach from the evidence you have." };
      if ((await claimAiBudget(service, "gemini", userId, estimateEmbeddingUnits(input.query.length))) !== "ok") {
        return { ok: false, content: "Search isn't available right now; teach from the evidence you have." };
      }
      hooks.onSearch();
      const units = await retrieve(args.userClient, exam.course_id, input.query, args.excludeRoles);
      const seen = new Set(sources.map((s) => s.unit_id));
      const fresh = units.filter((u) => !seen.has(u.unit_id));
      if (fresh.length === 0) return { ok: true, content: "No further course passages matched." };
      const offset = sources.length;
      const added = buildSources(fresh).map((s) => ({ ...s, n: s.n + offset }));
      sources.push(...added);
      hooks.send("sources", { sources, conversation_id: args.conversationId, policy_mode: args.mode });
      return { ok: true, content: evidenceBlock(added, fresh) };
    }

    case "show_inventory":
      hooks.pushBlock({ type: "inventory", inventory: args.context.inventory });
      return { ok: true, content: `Shown to the student.\n${inventorySummary(args.context.inventory)}` };

    case "ask_question": {
      const { question } = input;
      const { data: row, error } = await service
        .from("polya_practice_questions")
        .insert({
          user_id: userId,
          course_id: exam.course_id,
          exam_id: exam.id,
          topic_id: input.topicIds[0],
          topic_ids: input.topicIds,
          origin: "coach",
          hide_topic: input.hideTopic,
          difficulty: input.difficulty,
          conversation_id: args.conversationId,
          stem: question.stem,
          parts: question.parts,
          sources,
          model: COACH_MODEL,
        })
        .select("id")
        .single();
      if (error || !row) throw error ?? new Error("question insert returned nothing");
      const { error: keyError } = await service.from("polya_practice_keys").insert({
        question_id: row.id,
        user_id: userId,
        answers: question.keys,
        explanation: question.explanation,
        verification: { checked_by: "fixed rules", origin: "coach" },
      });
      if (keyError) {
        await service.from("polya_practice_questions").delete().eq("id", row.id);
        throw keyError;
      }
      hooks.pushBlock({
        type: "question",
        question: {
          id: row.id as string,
          stem: question.stem,
          parts: question.parts,
          difficulty: input.difficulty,
          hide_topic: input.hideTopic,
          ...(input.hideTopic ? {} : { topic_ids: input.topicIds }),
        },
      });
      return { ok: true, content: "The question is in front of the student. End your message now; they answer next." };
    }

    case "set_topic_stage": {
      const { error } = await service
        .from("polya_study_topics")
        .update({ stage: input.stage, stage_note: input.note || null, stage_updated_at: new Date().toISOString() })
        .eq("id", input.topicId)
        .eq("user_id", userId);
      if (error) throw error;
      const topic = args.context.topics.find((t) => t.id === input.topicId);
      if (topic) topic.stage = input.stage;
      hooks.pushBlock({ type: "stage", topic_id: input.topicId, title: input.title, stage: input.stage, note: input.note });
      return { ok: true, content: "Recorded." };
    }

    case "log_error": {
      const { data, error } = await service
        .from("polya_study_errors")
        .insert({
          user_id: userId,
          exam_id: exam.id,
          topic_id: input.topicId,
          question_id: args.eventIds.questionId,
          attempt_id: args.eventIds.attemptId,
          what: input.what,
          why: input.why,
          fix: input.fix,
        })
        .select("id, created_at")
        .single();
      if (error || !data) throw error ?? new Error("error insert returned nothing");
      hooks.pushBlock({
        type: "error_logged",
        error: {
          id: data.id as string,
          topic_id: input.topicId,
          question_id: args.eventIds.questionId,
          what: input.what,
          why: input.why,
          fix: input.fix,
          created_at: data.created_at as string,
        },
      });
      return { ok: true, content: "Added to the student's mistake log." };
    }

    case "save_plan": {
      // Keep ticks on tasks the new plan carries over unchanged.
      const done = new Set(
        (args.context.plan?.days ?? []).flatMap((d) => d.items.filter((i) => i.done).map((i) => `${d.date}|${i.text}`)),
      );
      for (const day of input.plan.days) for (const item of day.items) item.done = done.has(`${day.date}|${item.text}`);
      const updatedAt = new Date().toISOString();
      const { error } = await service
        .from("polya_exams")
        .update({ plan: input.plan, plan_updated_at: updatedAt })
        .eq("id", exam.id)
        .eq("user_id", userId);
      if (error) throw error;
      args.context.plan = input.plan;
      hooks.pushBlock({ type: "plan", plan: input.plan, updated_at: updatedAt });
      return { ok: true, content: "Saved and shown to the student." };
    }

    case "suggest_replies":
      hooks.pushBlock({ type: "replies", replies: input.replies });
      return { ok: true, content: "Shown." };

    case "create_mock_exam": {
      if (!(await withinDailyCap(service, userId, COACH_MOCK_DAILY_BUCKET, COACH_MOCK_DAILY_LIMIT))) {
        return { ok: false, content: "The student has set up as many mock exams as allowed today. Suggest one tomorrow." };
      }
      const { data, error } = await service
        .from("polya_mock_exams")
        .insert({
          user_id: userId,
          course_id: exam.course_id,
          exam_id: exam.id,
          title: input.title,
          minutes: input.minutes,
          spec: input.spec,
        })
        .select("id")
        .single();
      if (error || !data) throw error ?? new Error("mock insert returned nothing");
      hooks.pushBlock({
        type: "mock",
        mock: { id: data.id as string, title: input.title, minutes: input.minutes, question_count: input.spec.question_count },
      });
      return { ok: true, content: "Set up. The student starts it from the card when ready. End your message now." };
    }
  }
}

// ---------------------------------------------------------------------------
// Saving the turn.
// ---------------------------------------------------------------------------
async function persist(
  args: TurnArgs,
  segments: CoachSegment[],
  sources: EvidenceSource[],
  usage: StreamUsage,
  meta: { calls: number; tools: string[]; failed: string | null },
): Promise<string | null> {
  const topicTitle = (id: string) => args.context.topics.find((t) => t.id === id)?.title ?? null;
  const content = segments
    .map((s) => (s.type === "text" ? s.text.trim() : blockSummary(s.block, topicTitle)))
    .filter(Boolean)
    .join("\n\n");
  try {
    await service.from("polya_messages").insert({
      user_id: args.userId,
      conversation_id: args.conversationId,
      role: "user",
      content: args.studentMessage ?? (args.eventMeta ? eventContent(args.eventMeta) : ""),
      meta: args.eventMeta,
    });
    const { data } = await service
      .from("polya_messages")
      .insert({
        user_id: args.userId,
        conversation_id: args.conversationId,
        role: "assistant",
        content,
        blocks: segments,
        sources,
        policy_mode: args.mode,
        model: COACH_MODEL,
        usage,
        meta: { kind: "turn", ...meta },
      })
      .select("id")
      .single();
    await service
      .from("polya_conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", args.conversationId);
    return (data?.id as string) ?? null;
  } catch (error) {
    console.error("[polya-coach] persist failed:", error);
    return null;
  }
}
