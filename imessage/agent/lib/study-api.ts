// Calls polya-study for a linked student: grading an answer and writing new practice questions.
// The agent has no student session, so it uses the service-role key it already holds and names
// the student in x-polya-user-id. polya-study allows only generate_questions and submit_attempt
// this way, and applies the student's own windows, caps, AI budget and ownership checks (see the
// header of supabase/functions/polya-study/index.ts). The student id always comes from the
// session's auth (student.ts), never from the model.

export type StudyAction =
  | { action: "generate_questions"; exam_id: string; topic_id: string }
  | { action: "submit_attempt"; question_id: string; responses: unknown[] };

/** polya-study's { error, code } reply, kept so tools can tell the student what happened. */
export class StudyApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** For a bad_answer: the 0-based part polya-study couldn't read. */
  readonly part: number | null;
  constructor(message: string, code: string, status: number, part: number | null) {
    super(message);
    this.name = "StudyApiError";
    this.code = code;
    this.status = status;
    this.part = part;
  }
}

// Writing a batch runs up to ~140 s inside polya-study (its REQUEST_BUDGET_MS); wait a little longer.
const TIMEOUT_MS = 150_000;

export async function callStudy<T>(
  userId: string,
  body: StudyAction,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const base = env.POLYA_SUPABASE_URL?.replace(/\/+$/, "");
  const key = env.POLYA_SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error("POLYA_SUPABASE_URL and POLYA_SUPABASE_SERVICE_ROLE_KEY are required");

  let response: Response;
  try {
    response = await fetchImpl(`${base}/functions/v1/polya-study`, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        apikey: key,
        "x-polya-user-id": userId,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new StudyApiError(
      timedOut ? "That took longer than expected." : "Polya's study service couldn't be reached.",
      timedOut ? "slow" : "unavailable",
      503,
      null,
    );
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new StudyApiError(
      typeof data.error === "string" ? data.error : "Polya couldn't do that just now.",
      typeof data.code === "string" ? data.code : "internal",
      response.status,
      Number.isInteger(data.part) ? (data.part as number) : null,
    );
  }
  return data as T;
}
