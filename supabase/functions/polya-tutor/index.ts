// polya-tutor — course-aware tutoring over SSE.
// Flow: POST only -> auth -> input caps -> hourly window -> ownership -> daily
// meter (both fail closed) -> load policy
// + history -> classify intent -> hybrid retrieve -> build prompt (charter+policy
// cached, evidence untrusted-framed) -> stream Claude Sonnet 5 -> emit sources,
// then text deltas, then done; persist both messages before closing.
import { corsHeaders, json } from "../_shared/cors.ts";
import { HttpError, requireAuthUser, createUserClient } from "../_shared/auth-user.ts";
import { assertConversationOwned, assertCourseOwned } from "../_shared/authz.ts";
import { trackServer } from "../_shared/events.ts";
import { service } from "../_shared/service.ts";
import { checkAndCountTutorUsage } from "../_shared/usage.ts";
import { checkTutorMessage, TUTOR_MESSAGE_MAX_CHARS } from "../_shared/tutor-limits.ts";
import { aiBusyResponse, claimAiBudget, estimateModelUnits } from "../_shared/ai-budget.ts";
import { claimRateLimit } from "../_shared/rate-limit.ts";
import { HOUR_SECONDS, TUTOR_HOURLY_BUCKET, TUTOR_HOURLY_LIMIT } from "../_shared/polya-rate-limits.ts";
import { retrieve } from "../_shared/retrieval.ts";
import {
  buildSources,
  buildSystemBlocks,
  buildUserTurn,
  classifyIntent,
  LECTURE_CONTEXT_MAX_CHARS,
  masteryAskBlock,
  masteryJudgeBlock,
  normalizeLectureContext,
  parseVerdictLine,
  type EvidenceSource,
  type LectureContext,
  type MasteryVerdict,
  type PolicyMode,
} from "../_shared/prompts.ts";

const TUTOR_MODEL = "claude-sonnet-5";
const MODEL_ALLOWLIST = new Set(["claude-sonnet-5", "claude-haiku-4-5"]);
const MAX_TOKENS = 2048;
const HISTORY_TURNS = 12;
// COSTS.md §2's upper case (charter, ~24 evidence units, 12-turn history) is
// about 13,300 input tokens; at the budget's 3 chars/token that's ~40k chars.
const TUTOR_BASE_INPUT_CHARS = 42_000;
const ANTHROPIC_KEY = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } })
  .Deno?.env.get("ANTHROPIC_API_KEY") ?? "";

interface TutorBody {
  conversation_id?: string;
  course_id: string;
  message: string;
  attempt?: boolean;
  model?: string;
  // Lecture Mode. Either a plain string (the board text box) or a structured
  // window from a capture client; normalizeLectureContext collapses both.
  context?: unknown;
  // Mastery check: "start" makes the tutor pose one transfer question (a
  // polya_mastery_checks row is created); "answer" judges the student's
  // independent attempt at that question and records the verdict.
  mastery?: { phase: "start"; concept: string } | { phase: "answer"; check_id: string };
}

interface MasteryContext {
  phase: "start" | "answer";
  concept: string;
  checkId: string | null;
  question: string;
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  // A-17: a tutor turn is always a JSON POST.
  if (request.method !== "POST") {
    return json({ error: "Method not allowed.", code: "method_not_allowed" }, 405);
  }

  let user;
  try {
    user = await requireAuthUser(request);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 401;
    return json({ error: "Please sign in again.", code: "unauthorized" }, status);
  }

  let body: TutorBody;
  try {
    body = (await request.json()) as TutorBody;
  } catch {
    return json({ error: "Something went wrong sending that. Please try again.", code: "bad_request" }, 400);
  }
  const messageCheck = checkTutorMessage(body?.message);
  if (!body?.course_id || messageCheck === "missing") {
    return json({ error: "Missing course or message.", code: "bad_request" }, 400);
  }
  if (messageCheck === "too_long") {
    return json(
      {
        error: `That message is too long. Please keep it under ${TUTOR_MESSAGE_MAX_CHARS.toLocaleString("en-US")} characters.`,
        code: "too_long",
      },
      413,
    );
  }
  const model = body.model && MODEL_ALLOWLIST.has(body.model) ? body.model : TUTOR_MODEL;

  // A-17: hourly per-user window under the daily meter below. Keyed on the
  // user alone (no client-supplied id), so it can run before the ownership
  // checks. Fails closed: a limiter error refuses the turn.
  if (!(await claimRateLimit(service, `user:${user.id}`, TUTOR_HOURLY_BUCKET, TUTOR_HOURLY_LIMIT, HOUR_SECONDS))) {
    return json(
      {
        error: "You're sending messages quickly. Take a short break and try again in a little while.",
        code: "rate_limited",
      },
      429,
    );
  }

  // Client-supplied ids are written under via the service client (bypasses
  // RLS), so ownership must be proven before metering or any write.
  let mastery: MasteryContext | null = null;
  try {
    await assertCourseOwned(user.id, body.course_id);
    if (body.conversation_id) {
      await assertConversationOwned(user.id, body.conversation_id, body.course_id);
    }
    mastery = await resolveMastery(user.id, body);
  } catch (error) {
    if (error instanceof HttpError) {
      const code =
        error.status === 403 ? "forbidden" : error.status === 400 ? "bad_request" : "not_found";
      return json({ error: error.message, code }, error.status);
    }
    throw error;
  }

  // A mastery answer is the student working unaided, so the room is withheld
  // on that turn: it would invalidate the check, and it would hand whatever is
  // on a projector screen a route into the VERDICT control channel below.
  const lectureContext = normalizeLectureContext(body.context);
  const effectiveLecture = mastery?.phase === "answer" ? null : lectureContext;

  const meter = await checkAndCountTutorUsage(user.id);
  if (meter.unavailable) {
    return json(
      { error: "The tutor is unavailable right now. Please try again in a moment.", code: "unavailable" },
      503,
    );
  }
  if (!meter.allowed) {
    return json(
      { error: "You've reached today's study-chat limit. It resets tomorrow.", code: "rate_limited" },
      429,
    );
  }

  // Project-wide daily Claude budget (R-5), charged before retrieval at this
  // turn's ceiling: evidence, history and charter (TUTOR_BASE_INPUT_CHARS)
  // plus the message and any lecture context, and the full output allowance.
  // Fails closed: over budget or a metering error both get the busy 503.
  const budget = await claimAiBudget(
    service,
    "anthropic",
    user.id,
    estimateModelUnits(
      model,
      TUTOR_BASE_INPUT_CHARS + body.message.length + (effectiveLecture ? LECTURE_CONTEXT_MAX_CHARS : 0),
      MAX_TOKENS,
    ),
  );
  if (budget !== "ok") {
    return aiBusyResponse({ headers: corsHeaders });
  }

  const userClient = createUserClient(request);

  // Policy (default guided) + course name.
  const [{ data: course }, { data: policy }] = await Promise.all([
    userClient.from("polya_courses").select("name").eq("id", body.course_id).maybeSingle(),
    userClient
      .from("polya_course_policies")
      .select("mode, instructor_note")
      .eq("course_id", body.course_id)
      .maybeSingle(),
  ]);
  const mode = (policy?.mode ?? "guided") as PolicyMode;
  const studyNote = policy?.instructor_note ?? null; // column name is historical
  const courseName = course?.name ?? "your course";

  // Conversation (create if new) + recent history.
  const conversationId = await ensureConversation(user.id, body);
  const { data: historyRows } = await userClient
    .from("polya_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_TURNS);
  const history = ((historyRows ?? []) as Array<{ role: string; content: string }>)
    .reverse()
    .map((row) => ({ role: row.role as "user" | "assistant", content: row.content }));

  // Intent + retrieval (practice mode hides solution keys). A mastery-answer
  // turn retrieves on the check question — that's what the evidence must judge
  // the attempt against.
  const intent = classifyIntent(body.message, body.attempt);
  const excludeRoles = mode === "practice" ? ["solution_key"] : [];
  const retrievalQuery = mastery?.phase === "answer" ? mastery.question : body.message;
  const units = await retrieve(userClient, body.course_id, retrievalQuery, excludeRoles);
  const sources = buildSources(units);

  // Prompt assembly.
  const systemBlocks = buildSystemBlocks(courseName, mode, studyNote);
  const masteryBlock =
    mastery?.phase === "start"
      ? `\n\n${masteryAskBlock(mastery.concept)}`
      : mastery?.phase === "answer"
        ? `\n\n${masteryJudgeBlock(mastery.question)}`
        : "";
  const userTurn = buildUserTurn({
    intent,
    mode,
    masteryBlock,
    lecture: effectiveLecture,
    sources,
    units,
    message: body.message.trim(),
  });
  const messages = [...history, { role: "user" as const, content: userTurn }];

  return streamTutor({
    userId: user.id,
    courseId: body.course_id,
    conversationId,
    model,
    systemBlocks,
    messages,
    sources,
    mode,
    studentMessage: body.message.trim(),
    mastery,
    lecture: effectiveLecture,
  });
});

// Validate the mastery request and load the check being answered. Throws
// HttpError on any ownership/state mismatch.
async function resolveMastery(userId: string, body: TutorBody): Promise<MasteryContext | null> {
  if (!body.mastery) return null;
  if (body.mastery.phase === "start") {
    const concept = body.mastery.concept?.trim().slice(0, 200);
    if (!concept) throw new HttpError("Missing concept for the check.", 400);
    return { phase: "start", concept, checkId: null, question: "" };
  }
  const { data } = await service
    .from("polya_mastery_checks")
    .select("id, user_id, course_id, question, status")
    .eq("id", body.mastery.check_id)
    .maybeSingle();
  if (!data || data.user_id !== userId || data.course_id !== body.course_id) {
    throw new HttpError("That check isn't available.", 404);
  }
  if (data.status !== "asked") {
    throw new HttpError("That check is already finished — start a new one.", 400);
  }
  return { phase: "answer", concept: "", checkId: data.id as string, question: data.question as string };
}

// Ownership of a client-supplied conversation_id is asserted up front in the
// request handler (assertConversationOwned) before this runs.
async function ensureConversation(userId: string, body: TutorBody): Promise<string> {
  if (body.conversation_id) return body.conversation_id;
  const title = body.message.trim().slice(0, 60);
  const { data, error } = await service
    .from("polya_conversations")
    .insert({ user_id: userId, course_id: body.course_id, title })
    .select("id")
    .single();
  if (error || !data) throw new Error(`conversation create failed: ${error?.message}`);
  return data.id as string;
}

interface StreamArgs {
  userId: string;
  courseId: string;
  conversationId: string;
  model: string;
  systemBlocks: unknown[];
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  sources: EvidenceSource[];
  mode: PolicyMode;
  studentMessage: string;
  mastery: MasteryContext | null;
  lecture: LectureContext | null;
}

// A judge turn must open with "VERDICT: x\n"; buffer at most this many chars
// while looking for it before concluding the model deviated.
const VERDICT_BUFFER_MAX = 48;

function streamTutor(args: StreamArgs): Response {
  const encoder = new TextEncoder();
  const sse = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const judging = args.mastery?.phase === "answer";

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        sse("sources", {
          sources: args.sources,
          conversation_id: args.conversationId,
          policy_mode: args.mode,
          // Shape only. The window itself is a recording of a room and is never
          // echoed back, logged, or persisted.
          live_context: args.lecture
            ? {
                live: args.lecture.live,
                captured_at: args.lecture.capturedAt,
                transcript_chars: args.lecture.transcript?.length ?? 0,
                frames: args.lecture.frames.length,
                truncated: args.lecture.truncated,
              }
            : null,
        }),
      );

      // displayText is what the student sees (verdict header stripped);
      // headerBuffer accumulates the opening line of a judge turn.
      let displayText = "";
      let verdict: MasteryVerdict | null = null;
      let headerBuffer = "";
      let headerDone = !judging;
      let usage: unknown = null;

      const emitText = (text: string) => {
        if (!text) return;
        displayText += text;
        controller.enqueue(sse("delta", { text }));
      };

      const consumeHeader = (chunk: string) => {
        headerBuffer += chunk;
        const newline = headerBuffer.indexOf("\n");
        if (newline === -1) {
          if (headerBuffer.length > VERDICT_BUFFER_MAX) {
            // Too long for a verdict line — the model deviated; forward as-is.
            headerDone = true;
            emitText(headerBuffer);
          }
          return;
        }
        verdict = parseVerdictLine(headerBuffer.slice(0, newline));
        headerDone = true;
        if (verdict) {
          controller.enqueue(sse("mastery", { check_id: args.mastery!.checkId, verdict }));
          emitText(headerBuffer.slice(newline + 1).replace(/^\s*\n/, ""));
        } else {
          emitText(headerBuffer);
        }
      };

      try {
        const anthropic = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: args.model,
            max_tokens: MAX_TOKENS,
            stream: true,
            system: args.systemBlocks,
            messages: args.messages,
          }),
        });

        if (!anthropic.ok || !anthropic.body) {
          const detail = await anthropic.text().catch(() => "");
          console.error("[polya-tutor] anthropic error:", anthropic.status, detail.slice(0, 300));
          controller.enqueue(
            sse("error", { error: "The tutor is unavailable right now. Please try again." }),
          );
          controller.close();
          return;
        }

        for await (const evt of parseAnthropicSse(anthropic.body)) {
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            if (headerDone) emitText(evt.delta.text);
            else consumeHeader(evt.delta.text);
          } else if (evt.type === "message_delta" && evt.usage) {
            usage = evt.usage;
          }
        }
        // Stream ended while still buffering (single-line reply).
        if (!headerDone) {
          verdict = parseVerdictLine(headerBuffer);
          headerDone = true;
          if (verdict) {
            controller.enqueue(sse("mastery", { check_id: args.mastery!.checkId, verdict }));
          } else {
            emitText(headerBuffer);
          }
        }
      } catch (error) {
        console.error("[polya-tutor] stream error:", error);
        controller.enqueue(sse("error", { error: "The tutor connection dropped. Please try again." }));
        controller.close();
        return;
      }

      // Persist both turns (and the mastery outcome) before signalling done.
      const messageId = await persist(args, displayText, usage);
      const masteryCheckId = await persistMastery(args, displayText, verdict);
      await trackServer(args.userId, "tutor_turn", args.courseId, {
        mode: args.mode,
        had_board_context: Boolean(args.lecture),
        context_live: args.lecture?.live ?? false,
        context_chars:
          (args.lecture?.typed?.length ?? 0) +
          (args.lecture?.transcript?.length ?? 0) +
          (args.lecture?.frames.reduce((sum, frame) => sum + frame.length, 0) ?? 0),
        context_frames: args.lecture?.frames.length ?? 0,
        context_truncated: args.lecture?.truncated ?? false,
      });
      if (args.mastery?.phase === "answer" && verdict) {
        await trackServer(args.userId, "mastery_check_completed", args.courseId, { verdict });
        if (verdict === "pass") {
          await trackServer(args.userId, "mastery_check_passed", args.courseId);
        }
      }
      controller.enqueue(sse("done", { message_id: messageId, usage, mastery_check_id: masteryCheckId }));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

// Mastery bookkeeping after the stream: a "start" turn creates the check row
// (the streamed text IS the question); an "answer" turn records the verdict.
// Returns the check id for a start turn so the client can submit against it.
async function persistMastery(
  args: StreamArgs,
  displayText: string,
  verdict: MasteryVerdict | null,
): Promise<string | null> {
  if (!args.mastery) return null;
  try {
    if (args.mastery.phase === "start") {
      const { data, error } = await service
        .from("polya_mastery_checks")
        .insert({
          user_id: args.userId,
          course_id: args.courseId,
          conversation_id: args.conversationId,
          concept: args.mastery.concept,
          question: displayText,
          sources: args.sources,
          status: "asked",
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return (data?.id as string) ?? null;
    }
    if (verdict) {
      await service
        .from("polya_mastery_checks")
        .update({
          verdict,
          feedback: displayText,
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", args.mastery.checkId!);
    }
    // No parseable verdict → leave the check "asked" so the student can retry.
    return args.mastery.checkId;
  } catch (error) {
    console.error("[polya-tutor] mastery persist failed:", error);
    return null;
  }
}

async function persist(args: StreamArgs, assistantText: string, usage: unknown): Promise<string | null> {
  try {
    await service.from("polya_messages").insert({
      user_id: args.userId,
      conversation_id: args.conversationId,
      role: "user",
      content: args.studentMessage,
    });
    const { data } = await service
      .from("polya_messages")
      .insert({
        user_id: args.userId,
        conversation_id: args.conversationId,
        role: "assistant",
        content: assistantText,
        sources: args.sources,
        policy_mode: args.mode,
        model: args.model,
        usage,
      })
      .select("id")
      .single();
    await service
      .from("polya_conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", args.conversationId);
    return (data?.id as string) ?? null;
  } catch (error) {
    console.error("[polya-tutor] persist failed:", error);
    return null;
  }
}

// Minimal SSE parser for the Anthropic event stream.
async function* parseAnthropicSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ type: string; delta?: { type: string; text: string }; usage?: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const block of events) {
      const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // ignore keepalive / partial lines
      }
    }
  }
}
