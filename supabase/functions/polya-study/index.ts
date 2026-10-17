// polya-study — exam prep inside a course.
//
// Actions (POST, signed-in student):
//   propose_topics     suggest an exam's topic map from its scope note, formula
//                      sheet, past exams, syllabus and file list (one Claude call)
//   generate_questions write practice questions for one topic, then keep only
//                      those whose key is checked by fixed rules AND matched by
//                      an independent solve that never saw it (two Claude calls)
//   submit_attempt     grade an answer with fixed rules (written parts against
//                      their rubric, one Claude call), record it, and return
//                      the key and the worked explanation
//   flag_question      the student reports a bad question; it stops being served
//   build_mock         fill a mock exam with checked questions, writing one more
//                      checked batch per call when the bank runs short (the
//                      browser calls this until the mock is ready)
//   start_mock         start the clock (the server stamps start and due times)
//   submit_mock        grade a handed-in mock (blanks count as wrong) and store
//                      its report
//   toggle_plan_item   tick or untick one task in the exam's study plan
//
// Exams, which files are the formula sheet / past exams, and topic edits are
// plain RLS writes from the browser (polya_study migration); only work that
// needs the service role or a model call happens here.
//
// Flow: POST only -> body cap -> auth -> hourly window (fails closed) ->
// ownership of every client-supplied id -> daily cap and AI budget before
// each model call (both fail closed).
import { corsHeaders, json } from "../_shared/cors.ts";
import { createUserClient, HttpError, requireAuthUser } from "../_shared/auth-user.ts";
import { service } from "../_shared/service.ts";
import { downloadFromStorage } from "../_shared/ingest.ts";
import { retrieve } from "../_shared/retrieval.ts";
import { buildSources, evidenceBlock, type EvidenceSource } from "../_shared/prompts.ts";
import { trackServer } from "../_shared/events.ts";
import { claimRateLimit, rateLimitedResponse, withinDailyCap } from "../_shared/rate-limit.ts";
import {
  HOUR_SECONDS,
  STUDY_HOURLY_BUCKET,
  STUDY_HOURLY_LIMIT,
  STUDY_MAX_BODY_BYTES,
  STUDY_GRADE_DAILY_BUCKET,
  STUDY_GRADE_DAILY_LIMIT,
  STUDY_MOCK_WRITE_DAILY_BUCKET,
  STUDY_MOCK_WRITE_DAILY_LIMIT,
  STUDY_TOPICS_DAILY_BUCKET,
  STUDY_TOPICS_DAILY_LIMIT,
  STUDY_WRITE_DAILY_BUCKET,
  STUDY_WRITE_DAILY_LIMIT,
} from "../_shared/polya-rate-limits.ts";
import { aiBusyResponse, claimAiBudget, estimateEmbeddingUnits, estimateModelUnits } from "../_shared/ai-budget.ts";
import { readJsonCapped } from "../_shared/read-json-capped.ts";
import { bytesToBase64, callClaudeJson, type ClaudeJsonResult, type Effort } from "../_shared/claude-json.ts";
import {
  checkAgreement,
  CHECKER_SCHEMA,
  parseCheckerOutput,
  parseResponses,
  parseTopicsOutput,
  parseWriterOutput,
  prepareQuestion,
  type PreparedQuestion,
  questionForChecker,
  QUESTIONS_PER_CALL,
  TOPICS_SCHEMA,
  WRITER_SCHEMA,
  WRITER_SCHEMA_FR,
  type PublicPart,
} from "../_shared/study-questions.ts";
import {
  CHECKER_SYSTEM,
  checkerUserText,
  type ExamContext,
  type Excerpt,
  TOPICS_SYSTEM,
  topicsUserText,
  GRADER_SYSTEM,
  type GraderItem,
  graderUserText,
  WRITER_SYSTEM,
  WRITER_SYSTEM_FR,
  writerUserText,
} from "../_shared/study-prompts.ts";
import {
  GRADER_SCHEMA,
  gradeAttempt,
  gradePart,
  isBlankResponse,
  parseGraderOutput,
  type PartKey,
  type PartResponse,
  type PartResult,
  type WrittenGrade,
} from "../_shared/study-grade.ts";
import {
  biggestDeficit,
  buildMockReport,
  MOCK_MIN_QUESTIONS,
  pickMockQuestions,
  validateMockSpec,
  type BankQuestion,
} from "../_shared/study-mock.ts";
import { asPlan } from "../_shared/coach-blocks.ts";

// The tutor's model. It has a row in ai-budget.ts MODEL_PRICES, so budget
// estimates are exact without touching that shared file.
const STUDY_MODEL = "claude-sonnet-5";
const ANTHROPIC_KEY = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } })
  .Deno?.env.get("ANTHROPIC_API_KEY") ?? "";

// Calls are synchronous inside one request, so their timeouts must add up to
// well under the edge function's 150 s.
const TOPICS_CALL = { maxTokens: 6_000, effort: "medium" as Effort, timeoutMs: 100_000 };
const WRITER_CALL = { maxTokens: 12_000, effort: "high" as Effort, timeoutMs: 85_000 };
const CHECKER_CALL = { maxTokens: 6_000, effort: "medium" as Effort, timeoutMs: 50_000 };
const GRADER_CALL = { maxTokens: 6_000, effort: "medium" as Effort, timeoutMs: 60_000 };
const REQUEST_BUDGET_MS = 140_000;

// Formula sheets travel as the PDF itself (math survives) when small enough.
const DOC_MAX_BYTES = 8 * 1024 * 1024;
const DOC_MAX_PAGES = 10;
const DOC_SHEETS_MAX = 2;
// Budget estimate per attached PDF page: page text plus its image, ~3k tokens.
const DOC_CHARS_PER_PAGE = 9_000;
const PAST_EXAMS_MAX = 3;

const SLOW_MESSAGE = "Writing questions took longer than expected. Please try again.";
const UNAVAILABLE_MESSAGE = "Polya couldn't work on that just now. Please try again in a moment.";

interface StudyBody {
  action?: unknown;
  exam_id?: unknown;
  topic_id?: unknown;
  question_id?: unknown;
  responses?: unknown;
  note?: unknown;
  mock_id?: unknown;
  answers?: unknown;
  item_id?: unknown;
  done?: unknown;
}

interface ExamRow {
  id: string;
  course_id: string;
  title: string;
  exam_date: string | null;
  scope_note: string | null;
  examples_note: string | null;
}

interface SourceRow {
  id: string;
  title: string;
  source_kind: string;
  storage_path: string | null;
  page_count: number | null;
  size_bytes: number | null;
  status: string;
}

type DocumentBlock = {
  type: "document";
  source: { type: "base64"; media_type: "application/pdf"; data: string };
  title: string;
  cache_control?: { type: "ephemeral" };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HttpError(`Missing or invalid ${what}.`, 400);
  }
  return value;
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed.", code: "method_not_allowed" }, 405);
  }

  const parsed = await readJsonCapped<StudyBody>(request, STUDY_MAX_BODY_BYTES);
  if (!parsed.ok) {
    return parsed.status === 413
      ? json({ error: "That request is too large.", code: "too_large" }, 413)
      : json({ error: "Invalid request body.", code: "bad_request" }, 400);
  }
  const body = parsed.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Invalid request body.", code: "bad_request" }, 400);
  }

  try {
    const user = await requireAuthUser(request);

    if (!(await claimRateLimit(service, `user:${user.id}`, STUDY_HOURLY_BUCKET, STUDY_HOURLY_LIMIT, HOUR_SECONDS))) {
      return rateLimitedResponse({
        message: "You're going quickly. Take a short break and try again in a little while.",
        headers: corsHeaders,
      });
    }

    switch (body.action) {
      case "propose_topics":
        return await proposeTopics(user.id, requireId(body.exam_id, "exam"));
      case "generate_questions":
        return await generateQuestions(
          request,
          user.id,
          requireId(body.exam_id, "exam"),
          requireId(body.topic_id, "topic"),
        );
      case "submit_attempt":
        return await submitAttempt(user.id, requireId(body.question_id, "question"), body.responses);
      case "flag_question":
        return await flagQuestion(user.id, requireId(body.question_id, "question"), body.note);
      case "build_mock":
        return await buildMock(request, user.id, requireId(body.mock_id, "mock exam"));
      case "start_mock":
        return await startMock(user.id, requireId(body.mock_id, "mock exam"));
      case "submit_mock":
        return await submitMock(user.id, requireId(body.mock_id, "mock exam"), body.answers);
      case "toggle_plan_item":
        return await togglePlanItem(user.id, requireId(body.exam_id, "exam"), body.item_id, body.done);
      default:
        return json({ error: "Unknown action", code: "bad_request" }, 400);
    }
  } catch (error) {
    if (error instanceof HttpError) {
      const code = error.status === 401
        ? "unauthorized"
        : error.status === 404
        ? "not_found"
        : error.status === 409
        ? "conflict"
        : "bad_request";
      return json({ error: error.message, code }, error.status);
    }
    console.error("[polya-study] error:", error);
    return json({ error: UNAVAILABLE_MESSAGE, code: "internal" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Loading what a prompt needs (service role, always filtered by the owner).
// ---------------------------------------------------------------------------
async function loadExam(userId: string, examId: string): Promise<ExamRow> {
  const { data } = await service
    .from("polya_exams")
    .select("id, course_id, title, exam_date, scope_note, examples_note")
    .eq("id", examId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new HttpError("That exam isn't available.", 404);
  return data as ExamRow;
}

async function examContext(userId: string, exam: ExamRow): Promise<ExamContext> {
  const { data } = await service
    .from("polya_courses")
    .select("name")
    .eq("id", exam.course_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new HttpError("That course isn't in your library.", 404);
  return {
    courseName: String(data.name ?? "Course"),
    examTitle: exam.title,
    examDate: exam.exam_date,
    scopeNote: exam.scope_note,
    examplesNote: exam.examples_note,
  };
}

/** The files the student marked for this exam, by kind; only readable ones. */
async function markedFiles(userId: string, examId: string): Promise<{ sheets: SourceRow[]; pastExams: SourceRow[] }> {
  const { data } = await service
    .from("polya_exam_sources")
    .select("kind, source:polya_sources(id, title, source_kind, storage_path, page_count, size_bytes, status)")
    .eq("exam_id", examId)
    .eq("user_id", userId);
  const rows = (data ?? []) as unknown as { kind: string; source: SourceRow | null }[];
  const ready = (kind: string) =>
    rows.filter((row) => row.kind === kind && row.source?.status === "ready").map((row) => row.source!);
  return { sheets: ready("formula_sheet"), pastExams: ready("past_exam") };
}

async function sourceText(userId: string, sourceId: string, maxChars: number): Promise<string> {
  const { data } = await service
    .from("polya_content_units")
    .select("content, ordinal")
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .eq("unit_type", "chunk")
    .order("ordinal", { ascending: true })
    .limit(40);
  let text = "";
  for (const row of (data ?? []) as { content: string }[]) {
    if (text.length >= maxChars) break;
    text += `${text ? "\n" : ""}${row.content}`;
  }
  return text.slice(0, maxChars);
}

/** Small formula-sheet PDFs ride along whole; anything else as its text. */
async function formulaSheetInputs(userId: string, sheets: SourceRow[]): Promise<{
  documents: DocumentBlock[];
  excerpts: Excerpt[];
  docChars: number;
}> {
  const documents: DocumentBlock[] = [];
  const excerpts: Excerpt[] = [];
  let docChars = 0;
  for (const sheet of sheets.slice(0, DOC_SHEETS_MAX)) {
    const attachable = sheet.source_kind === "pdf" && sheet.storage_path && sheet.size_bytes !== null &&
      sheet.size_bytes <= DOC_MAX_BYTES && (sheet.page_count ?? DOC_MAX_PAGES + 1) <= DOC_MAX_PAGES;
    if (attachable) {
      try {
        const bytes = new Uint8Array(await downloadFromStorage(sheet.storage_path!));
        documents.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: bytesToBase64(bytes) },
          title: sheet.title.slice(0, 200),
        });
        docChars += (sheet.page_count ?? 1) * DOC_CHARS_PER_PAGE;
        continue;
      } catch (error) {
        console.warn("[polya-study] formula sheet download failed; using its text:", error);
      }
    }
    excerpts.push({ title: sheet.title, text: await sourceText(userId, sheet.id, 6_000) });
  }
  // One cache breakpoint after the documents: the same exam's sheets repeat
  // across calls, so later calls within a few minutes read them from cache.
  if (documents.length > 0) documents[documents.length - 1]!.cache_control = { type: "ephemeral" };
  return { documents, excerpts, docChars };
}

const textChars = (excerpts: readonly Excerpt[]) => excerpts.reduce((sum, e) => sum + e.text.length, 0);

/** Claims the Anthropic budget for one call, then makes it. */
async function budgetedCall(
  userId: string,
  inputChars: number,
  call: { maxTokens: number; effort: Effort; timeoutMs: number },
  args: { system: string; content: unknown[]; schema: Record<string, unknown> },
): Promise<ClaudeJsonResult | "busy"> {
  const units = estimateModelUnits(STUDY_MODEL, inputChars, call.maxTokens);
  if ((await claimAiBudget(service, "anthropic", userId, units)) !== "ok") return "busy";
  return await callClaudeJson({
    apiKey: ANTHROPIC_KEY,
    model: STUDY_MODEL,
    system: args.system,
    content: args.content,
    schema: args.schema,
    maxTokens: call.maxTokens,
    effort: call.effort,
    timeoutMs: call.timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// propose_topics
// ---------------------------------------------------------------------------
async function proposeTopics(userId: string, examId: string): Promise<Response> {
  const exam = await loadExam(userId, examId);
  const context = await examContext(userId, exam);

  const { count } = await service
    .from("polya_study_topics")
    .select("id", { count: "exact", head: true })
    .eq("exam_id", exam.id)
    .eq("user_id", userId);
  if ((count ?? 0) > 0) throw new HttpError("This exam already has topics.", 409);

  if (!(await withinDailyCap(service, userId, STUDY_TOPICS_DAILY_BUCKET, STUDY_TOPICS_DAILY_LIMIT))) {
    return rateLimitedResponse({
      message: "You've set up topics several times today. Try again tomorrow, or add topics yourself.",
      headers: corsHeaders,
    });
  }

  const [{ data: files }, { sheets, pastExams }, { data: syllabusUnits }] = await Promise.all([
    service
      .from("polya_sources")
      .select("id, title, module_name")
      .eq("course_id", exam.course_id)
      .eq("user_id", userId)
      .eq("status", "ready")
      .order("created_at", { ascending: true })
      .limit(150),
    markedFiles(userId, exam.id),
    service
      .from("polya_content_units")
      .select("content")
      .eq("course_id", exam.course_id)
      .eq("user_id", userId)
      .eq("content_role", "syllabus")
      .order("ordinal", { ascending: true })
      .limit(6),
  ]);
  const fileRows = (files ?? []) as { id: string; title: string; module_name: string | null }[];
  const sheetInputs = await formulaSheetInputs(userId, sheets);
  const pastExcerpts = await Promise.all(
    pastExams.slice(0, PAST_EXAMS_MAX).map(async (s) => ({ title: s.title, text: await sourceText(userId, s.id, 2_500) })),
  );

  const text = topicsUserText({
    exam: context,
    files: fileRows.map((f) => ({ title: f.title, module: f.module_name })),
    formulaSheets: sheetInputs.excerpts,
    pastExams: pastExcerpts,
    syllabus: ((syllabusUnits ?? []) as { content: string }[]).map((u) => u.content).join("\n") || null,
  });
  const result = await budgetedCall(
    userId,
    TOPICS_SYSTEM.length + text.length + sheetInputs.docChars,
    TOPICS_CALL,
    { system: TOPICS_SYSTEM, content: [...sheetInputs.documents, { type: "text", text }], schema: TOPICS_SCHEMA },
  );
  if (result === "busy") return aiBusyResponse({ headers: corsHeaders });
  if (!result.ok) {
    console.error(`[polya-study] topics call failed: ${result.failure} ${result.detail}`);
    return json({ error: UNAVAILABLE_MESSAGE, code: result.failure === "timeout" ? "slow" : "unavailable" }, 503);
  }
  const topics = parseTopicsOutput(result.value, fileRows.length);
  if (!topics) {
    return json({ error: "Polya couldn't find clear topics for this exam. Try adding the scope or marking the formula sheet.", code: "no_topics" }, 422);
  }

  const { data: inserted, error } = await service
    .from("polya_study_topics")
    .insert(
      topics.map((topic, i) => ({
        user_id: userId,
        exam_id: exam.id,
        position: i,
        title: topic.title,
        summary: topic.summary || null,
        key_formulas: topic.key_formulas,
        source_ids: topic.source_indexes.map((index) => fileRows[index]!.id),
        origin: "proposed",
      })),
    )
    .select("id, position, title, summary, key_formulas, source_ids, origin");
  if (error) throw error;
  await trackServer(userId, "study_topics_suggested", exam.course_id, { topics: topics.length });
  return json({ topics: inserted ?? [] });
}

// ---------------------------------------------------------------------------
// generate_questions
// ---------------------------------------------------------------------------
interface TopicInput {
  id: string;
  title: string;
  summary: string | null;
  key_formulas: string[];
}

async function loadTopic(userId: string, examId: string, topicId: string): Promise<TopicInput> {
  const { data: topicRow } = await service
    .from("polya_study_topics")
    .select("id, title, summary, key_formulas")
    .eq("id", topicId)
    .eq("exam_id", examId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!topicRow) throw new HttpError("That topic isn't available.", 404);
  return topicRow as TopicInput;
}

async function generateQuestions(request: Request, userId: string, examId: string, topicId: string): Promise<Response> {
  const started = Date.now();
  const exam = await loadExam(userId, examId);
  const topic = await loadTopic(userId, exam.id, topicId);

  if (!(await withinDailyCap(service, userId, STUDY_WRITE_DAILY_BUCKET, STUDY_WRITE_DAILY_LIMIT))) {
    return rateLimitedResponse({
      message: "That's today's limit for new questions. Questions you missed will still come back for review.",
      headers: corsHeaders,
    });
  }

  const batch = await writeVerifiedBatch(request, userId, exam, topic, { allowWritten: false, started });
  if (!batch.ok) return batch.response;
  return json({ questions: batch.saved, written: batch.written, kept: batch.saved.length });
}

interface SavedQuestion {
  id: string;
  topic_id: string;
  stem: string;
  parts: PublicPart[];
  sources: unknown;
  status: string;
  created_at: string;
}

type BatchOutcome = { ok: true; saved: SavedQuestion[]; written: number } | { ok: false; response: Response };

/**
 * One checked batch for a topic: write, check every key by fixed rules, have
 * an independent solve that never saw the keys agree, and save what passed.
 * The caller checks its own daily cap first.
 */
async function writeVerifiedBatch(
  request: Request,
  userId: string,
  exam: ExamRow,
  topic: TopicInput,
  options: { allowWritten: boolean; started: number },
): Promise<BatchOutcome> {
  const context = await examContext(userId, exam);

  // Course evidence for the topic (the same retrieval as the tutor). Its
  // query embedding is metered on the shared Gemini budget.
  const query = [topic.title, topic.summary ?? "", ...topic.key_formulas].join(" ").slice(0, 1_500);
  if ((await claimAiBudget(service, "gemini", userId, estimateEmbeddingUnits(query.length))) !== "ok") {
    return { ok: false, response: aiBusyResponse({ headers: corsHeaders }) };
  }
  const userClient = createUserClient(request);
  const units = await retrieve(userClient, exam.course_id, query, []);
  const sources: EvidenceSource[] = buildSources(units);
  const evidence = evidenceBlock(sources, units);

  const { sheets, pastExams } = await markedFiles(userId, exam.id);
  const sheetInputs = await formulaSheetInputs(userId, sheets);
  const pastExcerpts = await pastExamExcerpts(userId, pastExams, topic.title);
  const { data: recent } = await service
    .from("polya_practice_questions")
    .select("stem")
    .eq("topic_id", topic.id)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(10);

  // 1. Write.
  const writerSystem = options.allowWritten ? WRITER_SYSTEM_FR : WRITER_SYSTEM;
  const writerText = writerUserText({
    exam: context,
    topic,
    evidence,
    formulaSheets: sheetInputs.excerpts,
    pastExams: pastExcerpts,
    recentStems: ((recent ?? []) as { stem: string }[]).map((r) => r.stem),
    count: QUESTIONS_PER_CALL,
  });
  const written = await budgetedCall(
    userId,
    writerSystem.length + writerText.length + sheetInputs.docChars,
    WRITER_CALL,
    {
      system: writerSystem,
      content: [...sheetInputs.documents, { type: "text", text: writerText }],
      schema: options.allowWritten ? WRITER_SCHEMA_FR : WRITER_SCHEMA,
    },
  );
  if (written === "busy") return { ok: false, response: aiBusyResponse({ headers: corsHeaders }) };
  if (!written.ok) return { ok: false, response: writeFailure("writer", written) };
  const drafts = parseWriterOutput(written.value) ?? [];

  // 2. Fixed-rule checks on every key.
  const prepared: PreparedQuestion[] = [];
  const dropped: string[] = [];
  for (const draft of drafts.slice(0, QUESTIONS_PER_CALL)) {
    const result = prepareQuestion(draft, sources.length);
    if (result.ok) prepared.push(result.question);
    else dropped.push(result.reason);
  }

  // 3. An independent solve that never sees the keys.
  const kept: { question: PreparedQuestion; verification: Record<string, unknown> }[] = [];
  if (prepared.length > 0) {
    const remaining = REQUEST_BUDGET_MS - (Date.now() - options.started);
    if (remaining < 15_000) return { ok: false, response: json({ error: SLOW_MESSAGE, code: "slow" }, 503) };
    const checkerText = checkerUserText({
      evidence,
      formulaSheets: sheetInputs.excerpts,
      questions: prepared.map((q, i) => questionForChecker(i, q)),
    });
    const checked = await budgetedCall(
      userId,
      CHECKER_SYSTEM.length + checkerText.length + sheetInputs.docChars,
      { ...CHECKER_CALL, timeoutMs: Math.min(CHECKER_CALL.timeoutMs, remaining - 5_000) },
      { system: CHECKER_SYSTEM, content: [...sheetInputs.documents, { type: "text", text: checkerText }], schema: CHECKER_SCHEMA },
    );
    if (checked === "busy") return { ok: false, response: aiBusyResponse({ headers: corsHeaders }) };
    if (!checked.ok) return { ok: false, response: writeFailure("checker", checked) };
    const answers = parseCheckerOutput(checked.value) ?? [];
    prepared.forEach((question, i) => {
      const agreement = checkAgreement(question.keys, answers[i]);
      if (agreement.agree) {
        kept.push({ question, verification: { checked_by: STUDY_MODEL, agreed: true } });
      } else {
        dropped.push(agreement.reason);
      }
    });
  }
  if (dropped.length > 0) console.info(`[polya-study] dropped ${dropped.length}: ${dropped.join(" | ").slice(0, 600)}`);

  // 4. Save what passed.
  const saved: SavedQuestion[] = [];
  for (const { question, verification } of kept) {
    const { data: row, error } = await service
      .from("polya_practice_questions")
      .insert({
        user_id: userId,
        course_id: exam.course_id,
        exam_id: exam.id,
        topic_id: topic.id,
        stem: question.stem,
        parts: question.parts,
        sources,
        model: STUDY_MODEL,
      })
      .select("id, topic_id, stem, parts, sources, status, created_at")
      .single();
    if (error || !row) throw error ?? new Error("question insert returned nothing");
    const { error: keyError } = await service.from("polya_practice_keys").insert({
      question_id: row.id,
      user_id: userId,
      answers: question.keys,
      explanation: question.explanation,
      verification: { ...verification, dropped_in_batch: dropped.length },
    });
    if (keyError) {
      // A question without its key could never be graded: remove it.
      await service.from("polya_practice_questions").delete().eq("id", row.id);
      throw keyError;
    }
    saved.push(row as SavedQuestion);
  }

  await trackServer(userId, "study_questions_written", exam.course_id, {
    written: drafts.length,
    kept: saved.length,
    with_written_parts: options.allowWritten,
  });
  return { ok: true, saved, written: drafts.length };
}

/** Up to three past-exam excerpts on this topic, else each one's opening. */
async function pastExamExcerpts(userId: string, pastExams: SourceRow[], topicTitle: string): Promise<Excerpt[]> {
  if (pastExams.length === 0) return [];
  const titles = new Map(pastExams.map((s) => [s.id, s.title]));
  const { data } = await service
    .from("polya_content_units")
    .select("source_id, content")
    .in("source_id", [...titles.keys()])
    .eq("user_id", userId)
    .textSearch("search_vector", topicTitle, { type: "websearch", config: "english" })
    .limit(PAST_EXAMS_MAX);
  const hits = (data ?? []) as { source_id: string; content: string }[];
  if (hits.length > 0) return hits.map((h) => ({ title: titles.get(h.source_id) ?? "Past exam", text: h.content }));
  return await Promise.all(
    pastExams.slice(0, PAST_EXAMS_MAX).map(async (s) => ({ title: s.title, text: await sourceText(userId, s.id, 2_500) })),
  );
}

function writeFailure(stage: string, result: Extract<ClaudeJsonResult, { ok: false }>): Response {
  console.error(`[polya-study] ${stage} failed: ${result.failure} ${result.detail}`);
  if (result.failure === "timeout") return json({ error: SLOW_MESSAGE, code: "slow" }, 503);
  if (result.failure === "refusal") {
    return json({ error: "Polya couldn't write questions on this topic. Try another topic.", code: "declined" }, 422);
  }
  return json({ error: UNAVAILABLE_MESSAGE, code: "unavailable" }, 503);
}

// ---------------------------------------------------------------------------
// Written parts: one rubric-grader call for every written answer in a
// submission. Blank answers aren't sent (they score 0 without a model).
// ---------------------------------------------------------------------------
type WrittenWork = { item: GraderItem; question: number; part: number };

function writtenWork(
  questions: readonly { stem: string; parts: PublicPart[]; keys: PartKey[]; responses: PartResponse[] }[],
): WrittenWork[] {
  const work: WrittenWork[] = [];
  questions.forEach((q, qi) => {
    q.keys.forEach((key, pi) => {
      const response = q.responses[pi];
      if (key.kind !== "free_response" || !response || response.kind !== "free_response" || isBlankResponse(response)) return;
      const part = q.parts[pi];
      work.push({
        question: qi,
        part: pi,
        item: {
          item: work.length + 1,
          stem: q.stem,
          prompt: part?.prompt ?? "",
          rubric: key.rubric,
          modelAnswer: key.model_answer,
          points: key.points,
          answer: response.text,
        },
      });
    });
  });
  return work;
}

/** Grades written work; per question, a map from part index to its grade. */
async function gradeWritten(
  userId: string,
  work: readonly WrittenWork[],
): Promise<Map<number, Map<number, WrittenGrade>> | Response> {
  const byQuestion = new Map<number, Map<number, WrittenGrade>>();
  if (work.length === 0) return byQuestion;
  if (!(await withinDailyCap(service, userId, STUDY_GRADE_DAILY_BUCKET, STUDY_GRADE_DAILY_LIMIT))) {
    return rateLimitedResponse({
      message: "That's today's limit for checking written answers. Try again tomorrow.",
      headers: corsHeaders,
    });
  }
  const text = graderUserText(work.map((w) => w.item));
  const result = await budgetedCall(userId, GRADER_SYSTEM.length + text.length, GRADER_CALL, {
    system: GRADER_SYSTEM,
    content: [{ type: "text", text }],
    schema: GRADER_SCHEMA,
  });
  if (result === "busy") return aiBusyResponse({ headers: corsHeaders });
  if (!result.ok) {
    console.error(`[polya-study] grader failed: ${result.failure} ${result.detail}`);
    return json({
      error: "Polya couldn't read your written answer just now. Your answer is still here; please try again.",
      code: result.failure === "timeout" ? "slow" : "unavailable",
    }, 503);
  }
  const grades = parseGraderOutput(
    result.value,
    work.map((w) => ({ item: w.item.item, points: w.item.points, rubricCount: w.item.rubric.length })),
  );
  if (!grades) {
    return json({ error: "Polya couldn't read your written answer just now. Please try again.", code: "unavailable" }, 503);
  }
  for (const w of work) {
    const map = byQuestion.get(w.question) ?? new Map<number, WrittenGrade>();
    map.set(w.part, grades.get(w.item.item)!);
    byQuestion.set(w.question, map);
  }
  return byQuestion;
}

/** Question ids held by the student's mock exams that aren't handed in yet. */
async function reservedQuestionIds(userId: string, exceptMockId?: string): Promise<Set<string>> {
  const { data } = await service
    .from("polya_mock_exams")
    .select("id, question_ids")
    .eq("user_id", userId)
    .in("status", ["building", "ready", "in_progress"]);
  const ids = new Set<string>();
  for (const row of (data ?? []) as { id: string; question_ids: string[] }[]) {
    if (row.id === exceptMockId) continue;
    for (const id of row.question_ids ?? []) ids.add(id);
  }
  return ids;
}

const attemptTopicIds = (question: { topic_id: string; topic_ids?: string[] | null }) =>
  question.topic_ids && question.topic_ids.length > 0 ? question.topic_ids : [question.topic_id];

// ---------------------------------------------------------------------------
// submit_attempt
// ---------------------------------------------------------------------------
async function submitAttempt(userId: string, questionId: string, rawResponses: unknown): Promise<Response> {
  const responses = parseResponses(rawResponses);
  if (!responses) throw new HttpError("Those answers couldn't be read.", 400);

  const [{ data: question }, { data: key }] = await Promise.all([
    service
      .from("polya_practice_questions")
      .select("id, exam_id, topic_id, topic_ids, course_id, stem, parts, sources")
      .eq("id", questionId)
      .eq("user_id", userId)
      .maybeSingle(),
    service
      .from("polya_practice_keys")
      .select("answers, explanation")
      .eq("question_id", questionId)
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  if (!question || !key) throw new HttpError("That question isn't available.", 404);
  // A question waiting in a mock exam can't be answered (and its key read) early.
  if ((await reservedQuestionIds(userId)).has(questionId)) {
    throw new HttpError("This question is part of a mock exam you haven't handed in yet.", 409);
  }

  const keys = key.answers as PartKey[];
  const parts = question.parts as PublicPart[];
  // Check every other part first, so a typo doesn't spend a grader call.
  if (responses.length !== keys.length) {
    return json({ error: "Answer each part of the question once.", code: "bad_answer", part: 0 }, 400);
  }
  for (const [i, k] of keys.entries()) {
    if (k.kind === "free_response") {
      if (isBlankResponse(responses[i])) {
        return json({ error: "Write your answer before submitting.", code: "bad_answer", part: i }, 400);
      }
      continue;
    }
    const checked = gradePart(k, responses[i]!);
    if (!checked.ok) return json({ error: checked.message, code: "bad_answer", part: i }, 400);
  }

  const written = await gradeWritten(userId, writtenWork([{ stem: question.stem as string, parts, keys, responses }]));
  if (written instanceof Response) return written;
  const graded = gradeAttempt(keys, responses, { written: written.get(0) });
  if (!graded.ok) {
    return json({ error: graded.message, code: "bad_answer", part: graded.partIndex }, 400);
  }

  const { data: attempt, error } = await service
    .from("polya_practice_attempts")
    .insert({
      user_id: userId,
      question_id: question.id,
      exam_id: question.exam_id,
      topic_id: question.topic_id,
      topic_ids: attemptTopicIds(question as { topic_id: string; topic_ids: string[] | null }),
      responses,
      results: graded.grade.results,
      score: graded.grade.score,
      all_correct: graded.grade.allCorrect,
    })
    .select("id, created_at")
    .single();
  if (error) throw error;

  await trackServer(userId, "study_attempt", question.course_id as string, {
    score: graded.grade.score,
    written_parts: written.get(0)?.size ?? 0,
  });
  return json({
    attempt_id: (attempt as { id: string } | null)?.id ?? null,
    created_at: (attempt as { created_at: string } | null)?.created_at ?? new Date().toISOString(),
    topic_ids: attemptTopicIds(question as { topic_id: string; topic_ids: string[] | null }),
    results: graded.grade.results,
    score: graded.grade.score,
    all_correct: graded.grade.allCorrect,
    answers: keys,
    explanation: key.explanation,
    sources: question.sources,
  });
}

// ---------------------------------------------------------------------------
// flag_question
// ---------------------------------------------------------------------------
async function flagQuestion(userId: string, questionId: string, rawNote: unknown): Promise<Response> {
  const note = typeof rawNote === "string" ? rawNote.trim().slice(0, 1_000) : "";
  const { data } = await service
    .from("polya_practice_questions")
    .update({ status: "flagged" })
    .eq("id", questionId)
    .eq("user_id", userId)
    .select("id, course_id")
    .maybeSingle();
  if (!data) throw new HttpError("That question isn't available.", 404);
  await service
    .from("polya_practice_keys")
    .update({ flag_note: note || null, flagged_at: new Date().toISOString() })
    .eq("question_id", questionId)
    .eq("user_id", userId);
  await trackServer(userId, "study_question_reported", data.course_id as string, {});
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Mock exams
// ---------------------------------------------------------------------------
interface MockRow {
  id: string;
  exam_id: string;
  course_id: string;
  title: string;
  minutes: number;
  spec: unknown;
  question_ids: string[];
  status: "building" | "ready" | "in_progress" | "submitted";
  started_at: string | null;
  due_at: string | null;
  submitted_at: string | null;
  score: number | null;
  report: unknown;
}

const MOCK_COLUMNS = "id, exam_id, course_id, title, minutes, spec, question_ids, status, started_at, due_at, submitted_at, score, report";

async function loadMock(userId: string, mockId: string): Promise<MockRow> {
  const { data } = await service
    .from("polya_mock_exams")
    .select(MOCK_COLUMNS)
    .eq("id", mockId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new HttpError("That mock exam isn't available.", 404);
  return data as MockRow;
}

function mockState(mock: MockRow, total: number) {
  return { status: mock.status, built: mock.question_ids.length, total };
}

async function buildMock(request: Request, userId: string, mockId: string): Promise<Response> {
  const started = Date.now();
  const mock = await loadMock(userId, mockId);
  const total = Number((mock.spec as { question_count?: unknown })?.question_count) || mock.question_ids.length;
  if (mock.status !== "building") return json(mockState(mock, total));

  const exam = await loadExam(userId, mock.exam_id);
  const [{ data: topicRows }, { data: bankRows }, { data: attemptRows }, reserved] = await Promise.all([
    service.from("polya_study_topics").select("id, title, summary, key_formulas").eq("exam_id", exam.id).eq("user_id", userId),
    service
      .from("polya_practice_questions")
      .select("id, topic_id, status, origin, created_at")
      .eq("exam_id", exam.id)
      .eq("user_id", userId)
      .limit(1_000),
    service.from("polya_practice_attempts").select("question_id").eq("exam_id", exam.id).eq("user_id", userId).limit(5_000),
    reservedQuestionIds(userId, mock.id),
  ]);
  const topics = (topicRows ?? []) as TopicInput[];
  const spec = validateMockSpec(mock.spec, topics.map((t) => t.id));
  if (!spec.ok) throw new HttpError("This exam's topics changed since the mock was set up. Ask Polya for a new one.", 409);
  const bank = (bankRows ?? []) as BankQuestion[];
  const attempted = new Set(((attemptRows ?? []) as { question_id: string }[]).map((a) => a.question_id));

  let picked = pickMockQuestions({ spec: spec.spec, have: mock.question_ids, bank, attemptedIds: attempted, reservedIds: reserved });
  let have = [...mock.question_ids, ...picked.chosen];
  let writtenNote: string | null = null;

  const target = biggestDeficit(picked.deficits, spec.spec);
  if (target) {
    if (await withinDailyCap(service, userId, STUDY_MOCK_WRITE_DAILY_BUCKET, STUDY_MOCK_WRITE_DAILY_LIMIT)) {
      const topic = topics.find((t) => t.id === target)!;
      const batch = await writeVerifiedBatch(request, userId, exam, topic, { allowWritten: spec.spec.free_response, started });
      if (!batch.ok) {
        // Keep what was picked so far; the browser can try the next step again.
        await service.from("polya_mock_exams").update({ question_ids: have }).eq("id", mock.id).eq("status", "building");
        return batch.response;
      }
      if (batch.saved.length === 0) writtenNote = "kept_none";
      picked = pickMockQuestions({
        spec: spec.spec,
        have,
        bank: [...bank, ...batch.saved.map((q) => ({ ...q, origin: "bank" }))],
        attemptedIds: attempted,
        reservedIds: reserved,
      });
      have = [...have, ...picked.chosen];
    } else {
      writtenNote = "daily_cap";
    }
  }

  // Ready when full, or when nothing more can be written today and there's
  // enough for a real (shorter) mock.
  const full = have.length >= spec.spec.question_count;
  const stuck = writtenNote === "daily_cap" && have.length >= MOCK_MIN_QUESTIONS;
  const status = full || stuck ? "ready" : "building";
  if (writtenNote === "daily_cap" && !stuck) {
    await service.from("polya_mock_exams").update({ question_ids: have }).eq("id", mock.id).eq("status", "building");
    return rateLimitedResponse({
      message: "Polya has written as many new questions as it can today. Try again tomorrow to finish this mock exam.",
      headers: corsHeaders,
    });
  }
  const { error } = await service
    .from("polya_mock_exams")
    .update({ question_ids: have.slice(0, spec.spec.question_count), status })
    .eq("id", mock.id)
    .eq("status", "building");
  if (error) throw error;
  return json({ status, built: Math.min(have.length, spec.spec.question_count), total: spec.spec.question_count, short: stuck && !full });
}

async function mockQuestions(userId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const { data } = await service
    .from("polya_practice_questions")
    .select("id, topic_id, topic_ids, stem, parts, sources")
    .in("id", ids as string[])
    .eq("user_id", userId);
  const byId = new Map(((data ?? []) as { id: string }[]).map((q) => [q.id, q]));
  return ids.map((id) => byId.get(id)).filter(Boolean) as {
    id: string;
    topic_id: string;
    topic_ids: string[] | null;
    stem: string;
    parts: PublicPart[];
    sources: unknown;
  }[];
}

async function startMock(userId: string, mockId: string): Promise<Response> {
  let mock = await loadMock(userId, mockId);
  if (mock.status === "building") throw new HttpError("This mock exam isn't ready yet.", 409);
  if (mock.status === "submitted") throw new HttpError("This mock exam was already handed in.", 409);
  if (mock.status === "ready") {
    const now = Date.now();
    const { data, error } = await service
      .from("polya_mock_exams")
      .update({
        status: "in_progress",
        started_at: new Date(now).toISOString(),
        due_at: new Date(now + mock.minutes * 60_000).toISOString(),
      })
      .eq("id", mock.id)
      .eq("user_id", userId)
      .eq("status", "ready")
      .select(MOCK_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    // Another tab may have started it a moment ago: use whatever is stored.
    mock = (data as MockRow | null) ?? (await loadMock(userId, mockId));
  }
  const questions = await mockQuestions(userId, mock.question_ids);
  return json({
    mock: { id: mock.id, title: mock.title, minutes: mock.minutes, status: mock.status, started_at: mock.started_at, due_at: mock.due_at },
    // The student sees topics only after handing in.
    questions: questions.map((q) => ({ id: q.id, stem: q.stem, parts: q.parts })),
    server_now: new Date().toISOString(),
  });
}

function blankResponses(parts: readonly PublicPart[]): PartResponse[] {
  return parts.map((part): PartResponse => {
    switch (part.kind) {
      case "numeric":
        return { kind: "numeric", answer: "" };
      case "mc":
        return { kind: "mc", choice: -1 };
      case "select_all":
        return { kind: "select_all", choices: [] };
      case "free_response":
        return { kind: "free_response", text: "" };
    }
  });
}

function readMockAnswers(raw: unknown): Map<string, unknown> {
  const answers = new Map<string, unknown>();
  if (!Array.isArray(raw)) return answers;
  for (const entry of raw.slice(0, 12)) {
    if (entry && typeof entry === "object" && typeof (entry as { question_id?: unknown }).question_id === "string") {
      answers.set((entry as { question_id: string }).question_id, (entry as { responses?: unknown }).responses);
    }
  }
  return answers;
}

async function submitMock(userId: string, mockId: string, rawAnswers: unknown): Promise<Response> {
  const mock = await loadMock(userId, mockId);
  const questions = await mockQuestions(userId, mock.question_ids);
  const review = async (report: unknown) => {
    const { data: attempts } = await service
      .from("polya_practice_attempts")
      .select("id, question_id, responses, results, score, all_correct")
      .eq("mock_id", mock.id)
      .eq("user_id", userId);
    const { data: keys } = await service
      .from("polya_practice_keys")
      .select("question_id, answers, explanation")
      .in("question_id", mock.question_ids)
      .eq("user_id", userId);
    const keyBy = new Map(((keys ?? []) as { question_id: string }[]).map((k) => [k.question_id, k]));
    const attemptBy = new Map(((attempts ?? []) as { question_id: string }[]).map((a) => [a.question_id, a]));
    return json({
      report,
      questions: questions.map((q) => ({ ...q, attempt: attemptBy.get(q.id) ?? null, key: keyBy.get(q.id) ?? null })),
    });
  };
  if (mock.status === "submitted") return await review(mock.report);
  if (mock.status !== "in_progress" || !mock.started_at || !mock.due_at) {
    throw new HttpError("This mock exam hasn't been started.", 409);
  }

  // The hand-in time is fixed by the first submit; a retry keeps it.
  const submittedAt = mock.submitted_at ?? new Date().toISOString();
  if (!mock.submitted_at) {
    await service.from("polya_mock_exams").update({ submitted_at: submittedAt }).eq("id", mock.id).is("submitted_at", null);
  }

  const { data: existing } = await service
    .from("polya_practice_attempts")
    .select("question_id, topic_id, topic_ids, score, all_correct")
    .eq("mock_id", mock.id)
    .eq("user_id", userId);
  let rows = (existing ?? []) as { question_id: string; topic_id: string; topic_ids: string[] | null; score: number; all_correct: boolean }[];

  if (rows.length === 0) {
    const answers = readMockAnswers(rawAnswers);
    const { data: keyRows } = await service
      .from("polya_practice_keys")
      .select("question_id, answers")
      .in("question_id", mock.question_ids)
      .eq("user_id", userId);
    const keyBy = new Map(((keyRows ?? []) as { question_id: string; answers: PartKey[] }[]).map((k) => [k.question_id, k.answers]));
    const graded = questions.map((q) => {
      const parsed = parseResponses(answers.get(q.id));
      const responses = parsed && parsed.length === q.parts.length && parsed.every((r, i) => r.kind === q.parts[i]!.kind)
        ? parsed
        : blankResponses(q.parts);
      return { question: q, keys: keyBy.get(q.id) ?? [], responses };
    });
    const written = await gradeWritten(
      userId,
      writtenWork(graded.map((g) => ({ stem: g.question.stem, parts: g.question.parts, keys: g.keys, responses: g.responses }))),
    );
    if (written instanceof Response) return written;

    const inserts = [];
    for (const [i, g] of graded.entries()) {
      const result = gradeAttempt(g.keys, g.responses, { written: written.get(i), blankIsWrong: true });
      const results: PartResult[] = result.ok ? result.grade.results : g.keys.map(() => ({ ok: true, correct: false }));
      const score = result.ok ? result.grade.score : 0;
      inserts.push({
        user_id: userId,
        question_id: g.question.id,
        exam_id: mock.exam_id,
        topic_id: g.question.topic_id,
        topic_ids: attemptTopicIds(g.question),
        mock_id: mock.id,
        responses: g.responses,
        results,
        score,
        all_correct: result.ok && result.grade.allCorrect,
      });
    }
    const { error } = await service.from("polya_practice_attempts").insert(inserts);
    if (error) throw error;
    rows = inserts.map((r) => ({
      question_id: r.question_id,
      topic_id: r.topic_id,
      topic_ids: r.topic_ids,
      score: r.score,
      all_correct: r.all_correct,
    }));
  }

  const { data: topicRows } = await service.from("polya_study_topics").select("id, title").eq("exam_id", mock.exam_id).eq("user_id", userId);
  const report = buildMockReport({
    results: rows,
    topics: (topicRows ?? []) as { id: string; title: string }[],
    startedAt: mock.started_at,
    dueAt: mock.due_at,
    submittedAt,
  });
  const { error } = await service
    .from("polya_mock_exams")
    .update({ status: "submitted", score: report.score, report })
    .eq("id", mock.id)
    .eq("user_id", userId);
  if (error) throw error;
  await trackServer(userId, "study_mock_submitted", mock.course_id, { score: report.score, questions: report.possible });
  return await review(report);
}

// ---------------------------------------------------------------------------
// toggle_plan_item
// ---------------------------------------------------------------------------
async function togglePlanItem(userId: string, examId: string, itemId: unknown, done: unknown): Promise<Response> {
  if (typeof itemId !== "string" || !itemId || itemId.length > 64 || typeof done !== "boolean") {
    throw new HttpError("Missing or invalid plan item.", 400);
  }
  const { data } = await service.from("polya_exams").select("id, plan").eq("id", examId).eq("user_id", userId).maybeSingle();
  if (!data) throw new HttpError("That exam isn't available.", 404);
  const plan = asPlan((data as { plan: unknown }).plan);
  const item = plan?.days.flatMap((d) => d.items).find((i) => i.id === itemId);
  if (!plan || !item) throw new HttpError("That plan item isn't there any more.", 404);
  item.done = done;
  const { error } = await service.from("polya_exams").update({ plan }).eq("id", examId).eq("user_id", userId);
  if (error) throw error;
  return json({ plan });
}
