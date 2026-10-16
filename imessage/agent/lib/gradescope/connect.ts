// POST /polya/gradescope/connect (channels/gradescope-connect.ts). The askpolya.com connect page
// calls it server-side for a signed-in student, with `Authorization: Bearer $POLYA_CONNECT_SECRET`:
//
//   { user_id, mode: "cookie", cookie, email? }       school sign-in (SSO) accounts
//   { user_id, mode: "password", email, password }    Gradescope password accounts
//   { user_id, action: "status" }                     the saved connection's state
//
// A connect signs in to Gradescope, lists the student's courses, saves the sealed session (and the
// sealed password, in password mode only), and clears any reconnect notice. Responses:
//   200 { ok: true, courses, course_names }          student courses; at most 30 names
//   200 { ok: true, connected, last_error }          for action "status"; last_error is set only
//                                                    when the student has to reconnect
//   4xx/503 { ok: false, code, message }             codes below; messages are for the student
//
// The handler takes its I/O as deps so tests cover auth and validation without the eve runtime.
// Cookies and passwords are never logged or echoed back.
import { z } from "zod";

import { isAuthorizedTrigger } from "../check-ins-trigger.ts";
import { GradescopeClient, GradescopeError, type GradescopeClientOptions } from "./client.ts";
import type { SaveConnectionInput } from "./store.ts";
import type { GsCourse, GsSession } from "./types.ts";

export const CONNECT_LIMITS = {
  bodyBytes: 16 * 1024,
  cookieChars: 8 * 1024,
  emailChars: 320,
  passwordChars: 1024,
  courseNames: 30,
} as const;

export type ConnectErrorCode = "invalid_credentials" | "sso_required" | "session_expired" | "bad_request" | "unavailable";

export type ConnectRequest =
  | { readonly kind: "status"; readonly userId: string }
  | { readonly kind: "cookie"; readonly userId: string; readonly cookie: string; readonly email: string | null }
  | { readonly kind: "password"; readonly userId: string; readonly email: string; readonly password: string };

export type SignInRequest = Extract<ConnectRequest, { kind: "cookie" | "password" }>;

export interface SignedIn {
  readonly session: GsSession;
  readonly courses: readonly GsCourse[];
}

export interface ConnectDeps {
  /** POLYA_CONNECT_SECRET; unset or under 32 characters refuses every request. */
  readonly secret: string | undefined;
  /** Throws when the agent can't store a connection (GRADESCOPE_SECRET_KEY missing or malformed). */
  checkReady(): void;
  /** Signs in and lists courses. Throws GradescopeError or ConnectInputError. */
  signIn(request: SignInRequest): Promise<SignedIn>;
  save(userId: string, input: SaveConnectionInput): Promise<void>;
  status(userId: string): Promise<{ readonly connected: boolean; readonly last_error: string | null }>;
  /** Clears the reconnect notice and cached failures, and tells the student's thread. Never throws. */
  afterConnect(userId: string): Promise<void>;
  logError?(message: string, details: Record<string, unknown>): void;
}

/** The pasted sign-in has none of the cookies Gradescope signs in with. */
export class ConnectInputError extends Error {}

/** Cookies a signed-in Gradescope browser carries; a paste needs at least one. */
const SESSION_COOKIES = ["signed_token", "remember_me", "_gradescope_session"] as const;

const MESSAGES = {
  invalid_credentials: "Gradescope didn't accept that email and password. Check them and try again.",
  login_failed: "Gradescope didn't accept that sign-in. Check your email and password and try again.",
  sso_required:
    "This Gradescope account signs in through your school, so it doesn't have a Gradescope password. Connect it with your school sign-in instead.",
  session_expired: "That Gradescope sign-in has expired or isn't valid. Sign in to Gradescope again, then try once more.",
  not_a_sign_in: "That doesn't look like a Gradescope sign-in. Copy it again from a signed-in Gradescope tab and try once more.",
  unavailable: "Gradescope couldn't be reached just now. Try again in a few minutes.",
  not_ready: "Gradescope can't be connected just now. Try again in a few minutes.",
  save_failed: "Your Gradescope sign-in worked, but it couldn't be saved just now. Try again in a minute.",
  status_failed: "Couldn't check the Gradescope connection just now. Try again in a minute.",
} as const;

const userId = z.uuid();
const statusBody = z.object({ user_id: userId, action: z.literal("status") });
const connectBody = z.object({
  user_id: userId,
  mode: z.enum(["cookie", "password"]),
  cookie: z.string().max(CONNECT_LIMITS.cookieChars).optional(),
  email: z.string().max(CONNECT_LIMITS.emailChars).optional(),
  password: z.string().max(CONNECT_LIMITS.passwordChars).optional(),
});

/** Validates a parsed JSON body. Messages name the field, never its value. */
export function parseConnectRequest(body: unknown): { ok: true; request: ConnectRequest } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: "Body must be a JSON object." };

  if ("action" in body) {
    const parsed = statusBody.safeParse(body);
    if (!parsed.success) return { ok: false, message: issueMessage(parsed.error, body) };
    return { ok: true, request: { kind: "status", userId: parsed.data.user_id } };
  }

  const parsed = connectBody.safeParse(body);
  if (!parsed.success) return { ok: false, message: issueMessage(parsed.error, body) };
  const { user_id, mode, cookie, email, password } = parsed.data;
  const trimmedEmail = email?.trim() ?? "";
  if (mode === "cookie") {
    const trimmedCookie = cookie?.trim() ?? "";
    if (!trimmedCookie) return { ok: false, message: "cookie is required in cookie mode." };
    // A password sent in cookie mode is ignored: it's never stored.
    return { ok: true, request: { kind: "cookie", userId: user_id, cookie: trimmedCookie, email: trimmedEmail || null } };
  }
  if (!trimmedEmail) return { ok: false, message: "email is required in password mode." };
  if (!password) return { ok: false, message: "password is required in password mode." };
  return { ok: true, request: { kind: "password", userId: user_id, email: trimmedEmail, password } };
}

function issueMessage(error: z.ZodError, body: object): string {
  const issue = error.issues[0];
  const field = issue?.path.join(".") || "body";
  if (issue?.code === "too_big") return `${field} is too long.`;
  const key = issue?.path[0];
  if (typeof key === "string" && !(key in body)) return `${field} is required.`;
  return `${field} is invalid.`;
}

/** Signs in to Gradescope the way the page asked and lists the account's courses. */
export async function signInToGradescope(request: SignInRequest, options: GradescopeClientOptions = {}): Promise<SignedIn> {
  let client: GradescopeClient;
  if (request.kind === "cookie") {
    client = GradescopeClient.fromSessionCookies(request.cookie, options);
    if (!SESSION_COOKIES.some((name) => client.hasCookie(name))) throw new ConnectInputError("no Gradescope sign-in cookies");
    if (!(await client.verify())) throw new GradescopeError("session_expired", "Gradescope didn't accept the pasted sign-in");
  } else {
    client = new GradescopeClient(options);
    await client.loginWithPassword(request.email, request.password);
  }
  const courses = await client.listCourses();
  return { session: client.exportSession(), courses };
}

export async function handleGradescopeConnect(request: Request, deps: ConnectDeps): Promise<Response> {
  if (!isAuthorizedTrigger(request.headers.get("authorization"), deps.secret)) {
    return Response.json(
      { ok: false, code: "unauthorized", message: "Missing or invalid bearer token." },
      { status: 401, headers: { "cache-control": "no-store", "www-authenticate": "Bearer" } },
    );
  }

  const text = await readBody(request, CONNECT_LIMITS.bodyBytes);
  if (text === null) return fail(400, "bad_request", "Request body is too large.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "bad_request", "Request body must be JSON.");
  }
  const parsed = parseConnectRequest(body);
  if (!parsed.ok) return fail(400, "bad_request", parsed.message);
  const req = parsed.request;

  if (req.kind === "status") {
    try {
      const status = await deps.status(req.userId);
      return ok({ ok: true, connected: status.connected, last_error: status.last_error });
    } catch (error) {
      deps.logError?.("status read failed", { userId: req.userId, error: describe(error) });
      return fail(503, "unavailable", MESSAGES.status_failed);
    }
  }

  try {
    deps.checkReady();
  } catch (error) {
    deps.logError?.("not ready to store connections", { error: describe(error) });
    return fail(503, "unavailable", MESSAGES.not_ready);
  }

  let signedIn: SignedIn;
  try {
    signedIn = await deps.signIn(req);
  } catch (error) {
    const failure = signInFailure(error);
    if (failure.status === 503) {
      deps.logError?.("gradescope sign-in failed", { userId: req.userId, mode: req.kind, error: errorCode(error) });
    }
    return fail(failure.status, failure.code, failure.message);
  }

  try {
    await deps.save(req.userId, {
      email: req.email,
      session: signedIn.session,
      password: req.kind === "password" ? req.password : null,
    });
  } catch (error) {
    deps.logError?.("saving the connection failed", { userId: req.userId, error: describe(error) });
    return fail(503, "unavailable", MESSAGES.save_failed);
  }

  await deps.afterConnect(req.userId);
  const student = signedIn.courses.filter((course) => course.role === "student");
  return ok({
    ok: true,
    courses: student.length,
    course_names: student.slice(0, CONNECT_LIMITS.courseNames).map((course) => course.short_name || course.name),
  });
}

/** Maps a sign-in failure to the page's status, code, and message. */
export function signInFailure(error: unknown): { status: 422 | 503; code: ConnectErrorCode; message: string } {
  if (error instanceof ConnectInputError) return { status: 422, code: "session_expired", message: MESSAGES.not_a_sign_in };
  if (!(error instanceof GradescopeError)) return { status: 503, code: "unavailable", message: MESSAGES.unavailable };
  switch (error.code) {
    case "invalid_credentials":
      return { status: 422, code: "invalid_credentials", message: MESSAGES.invalid_credentials };
    case "login_failed":
      return { status: 422, code: "invalid_credentials", message: MESSAGES.login_failed };
    case "sso_required":
      return { status: 422, code: "sso_required", message: MESSAGES.sso_required };
    case "session_expired":
      return { status: 422, code: "session_expired", message: MESSAGES.session_expired };
    case "missing_token":
    case "http":
    case "network":
      return { status: 503, code: "unavailable", message: MESSAGES.unavailable };
  }
}

/** The body as text, or null when it's over `maxBytes` (declared or actual). */
async function readBody(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function ok(body: Record<string, unknown>): Response {
  return Response.json(body, { status: 200, headers: { "cache-control": "no-store" } });
}

function fail(status: 400 | 422 | 503, code: ConnectErrorCode, message: string): Response {
  return Response.json({ ok: false, code, message }, { status, headers: { "cache-control": "no-store" } });
}

function errorCode(error: unknown): string {
  return error instanceof GradescopeError ? error.code : describe(error);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
