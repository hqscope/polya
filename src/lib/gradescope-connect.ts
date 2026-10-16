// Reconnecting a student's Gradescope account from /connect/gradescope. The
// page asks the Polya iMessage agent whether Gradescope is connected, and the
// form's server action sends the student's Gradescope cookie (school sign-in)
// or email and password to the agent, which checks them and saves the
// connection. These helpers are the pure parts: input checks, the agent's
// request and reply shapes, and the copy for each outcome.
//
// No imports on purpose: Node's test runner loads this file directly.

/** This page. Also an allowed sign-in return path (next-path.ts). */
export const GRADESCOPE_CONNECT_PATH = "/connect/gradescope";

/** Where the agent runs when POLYA_IMESSAGE_AGENT_URL isn't set. */
export const DEFAULT_AGENT_URL = "https://polya-imessage.vercel.app";

/** The agent's endpoint for both connecting and the status check. */
export const AGENT_CONNECT_ENDPOINT = "/polya/gradescope/connect";

/** Connecting signs in to Gradescope and lists courses, so it gets a while. */
export const CONNECT_TIMEOUT_MS = 30_000;

/** The status check holds up the page render, so it gets less. */
export const STATUS_TIMEOUT_MS = 10_000;

// A Gradescope Cookie header is a few KB. Same cap as the agent
// (CONNECT_LIMITS.cookieChars in imessage/agent/lib/gradescope/connect.ts), so
// a paste the agent would refuse gets the "too long" message here instead.
export const MAX_COOKIE_LENGTH = 8_192;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_PASSWORD_LENGTH = 1_024;

/** Either cookie means the browser was signed in to Gradescope. */
const GRADESCOPE_SESSION_COOKIES = new Set(["signed_token", "_gradescope_session"]);

const MAX_COURSE_NAMES = 100;
const MAX_COURSE_NAME_LENGTH = 200;

export type ConnectMode = "cookie" | "password";

export type ConnectRequest =
  | { mode: "cookie"; cookie: string }
  | { mode: "password"; email: string; password: string };

/** Codes the agent replies with in `{ ok: false, code, message }`. */
export type AgentErrorCode =
  | "invalid_credentials"
  | "sso_required"
  | "session_expired"
  | "bad_request"
  | "unavailable";

/** Problems caught before anything is sent. */
export type InputErrorCode =
  | "cookie_missing"
  | "cookie_too_long"
  | "cookie_not_gradescope"
  | "email_invalid"
  | "password_missing"
  | "password_too_long";

export type ConnectErrorCode =
  | AgentErrorCode
  | InputErrorCode
  | "signed_out"
  | "timeout"
  | "unknown";

/** What the server action hands back to the form. Never holds the cookie or password. */
export type ConnectState =
  | { step: "idle" }
  | { step: "error"; code: ConnectErrorCode }
  | { step: "connected"; courses: number; courseNames: string[] };

export type ConnectResult =
  | { ok: true; courses: number; courseNames: string[] }
  | { ok: false; code: AgentErrorCode | "timeout" | "unknown" };

/**
 * - connected: Gradescope is connected and its last check worked.
 * - broken: the agent recorded an error for this student's connection.
 * - not_connected: no Gradescope connection yet.
 * - unknown: the status check failed; the form still works.
 */
export type GradescopeStatus = "connected" | "broken" | "not_connected" | "unknown";

const AGENT_ERROR_CODES: ReadonlySet<string> = new Set<AgentErrorCode>([
  "invalid_credentials",
  "sso_required",
  "session_expired",
  "bad_request",
  "unavailable",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The agent's endpoint URL, from POLYA_IMESSAGE_AGENT_URL or the default. */
export function agentConnectUrl(base: string | null | undefined): string {
  const trimmed = (base ?? "").trim().replace(/\/+$/, "");
  return `${trimmed || DEFAULT_AGENT_URL}${AGENT_CONNECT_ENDPOINT}`;
}

/**
 * The pasted value, tidied: line breaks and tabs removed (cookie values never
 * contain whitespace, so a paste that wrapped is rejoined), surrounding space
 * trimmed, and a leading `Cookie:` dropped for a student who copied the whole
 * header line.
 */
export function normalizeCookie(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, "")
    .trim()
    .replace(/^cookie:\s*/i, "")
    .trim();
}

/** True when the header has a signed_token or _gradescope_session cookie with a value. */
export function hasGradescopeSessionCookie(cookie: string): boolean {
  return cookie.split(";").some((part) => {
    const eq = part.indexOf("=");
    if (eq <= 0) return false;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    return GRADESCOPE_SESSION_COOKIES.has(name) && value.length > 0;
  });
}

export function validateCookie(
  raw: unknown,
): { ok: true; cookie: string } | { ok: false; code: InputErrorCode } {
  if (typeof raw !== "string") return { ok: false, code: "cookie_missing" };
  // Checked before tidying too, so a huge paste isn't scanned at all.
  if (raw.length > MAX_COOKIE_LENGTH * 2) return { ok: false, code: "cookie_too_long" };
  const cookie = normalizeCookie(raw);
  if (cookie.length === 0) return { ok: false, code: "cookie_missing" };
  if (cookie.length > MAX_COOKIE_LENGTH) return { ok: false, code: "cookie_too_long" };
  // C0 and DEL control characters can't be in a cookie.
  if (/[\u0000-\u001f\u007f]/.test(cookie)) return { ok: false, code: "cookie_not_gradescope" };
  if (!hasGradescopeSessionCookie(cookie)) return { ok: false, code: "cookie_not_gradescope" };
  return { ok: true, cookie };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(
  raw: unknown,
): { ok: true; email: string } | { ok: false; code: InputErrorCode } {
  if (typeof raw !== "string") return { ok: false, code: "email_invalid" };
  const email = raw.trim();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return { ok: false, code: "email_invalid" };
  }
  return { ok: true, email };
}

/** Passwords aren't trimmed: spaces can be part of one. */
export function validatePassword(
  raw: unknown,
): { ok: true; password: string } | { ok: false; code: InputErrorCode } {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, code: "password_missing" };
  if (raw.length > MAX_PASSWORD_LENGTH) return { ok: false, code: "password_too_long" };
  return { ok: true, password: raw };
}

/**
 * The connect request from the form's fields (FormData values: a string, a
 * File, or null). A mode that is neither "cookie" nor "password" is a
 * bad request rather than a guess.
 */
export function parseConnectForm(fields: {
  mode: unknown;
  cookie?: unknown;
  email?: unknown;
  password?: unknown;
}):
  | { ok: true; request: ConnectRequest }
  | { ok: false; code: InputErrorCode | "bad_request" } {
  if (fields.mode === "cookie") {
    const cookie = validateCookie(fields.cookie);
    return cookie.ok
      ? { ok: true, request: { mode: "cookie", cookie: cookie.cookie } }
      : cookie;
  }
  if (fields.mode === "password") {
    const email = validateEmail(fields.email);
    if (!email.ok) return email;
    const password = validatePassword(fields.password);
    if (!password.ok) return password;
    return {
      ok: true,
      request: { mode: "password", email: email.email, password: password.password },
    };
  }
  return { ok: false, code: "bad_request" };
}

/** The JSON body for a connect call. `userId` must come from the session. */
export function connectRequestBody(userId: string, request: ConnectRequest) {
  return request.mode === "cookie"
    ? { user_id: userId, mode: "cookie" as const, cookie: request.cookie }
    : {
        user_id: userId,
        mode: "password" as const,
        email: request.email,
        password: request.password,
      };
}

/** The JSON body for a status check. `userId` must come from the session. */
export function statusRequestBody(userId: string) {
  return { user_id: userId, action: "status" as const };
}

/**
 * The agent's reply to a connect call. `{ ok: true }` on a 2xx is a success;
 * `{ ok: false }` with a known code is that code, whatever the HTTP status;
 * anything else (a 401 for a wrong secret, a 5xx, a body that isn't JSON) is
 * "unknown". The agent's own `message` is never shown: the page has its own
 * copy for each code.
 */
export function parseConnectResponse(httpStatus: number, body: unknown): ConnectResult {
  if (!isRecord(body)) return { ok: false, code: "unknown" };

  if (body.ok === true && httpStatus >= 200 && httpStatus < 300) {
    const courseNames = Array.isArray(body.course_names)
      ? body.course_names
          .filter((name): name is string => typeof name === "string")
          .map((name) => name.trim().slice(0, MAX_COURSE_NAME_LENGTH))
          .filter((name) => name.length > 0)
          .slice(0, MAX_COURSE_NAMES)
      : [];
    const courses =
      typeof body.courses === "number" && Number.isInteger(body.courses) && body.courses >= 0
        ? body.courses
        : courseNames.length;
    return { ok: true, courses, courseNames };
  }

  if (body.ok === false && typeof body.code === "string" && AGENT_ERROR_CODES.has(body.code)) {
    return { ok: false, code: body.code as AgentErrorCode };
  }
  return { ok: false, code: "unknown" };
}

/** The agent's reply to a status check, `{ ok: true, connected, last_error }`. */
export function parseStatusResponse(httpStatus: number, body: unknown): GradescopeStatus {
  if (httpStatus < 200 || httpStatus >= 300 || !isRecord(body)) return "unknown";
  if (body.ok !== true || typeof body.connected !== "boolean") return "unknown";
  const lastError = body.last_error;
  const hasError =
    lastError !== null &&
    lastError !== undefined &&
    lastError !== false &&
    !(typeof lastError === "string" && lastError.trim() === "");
  if (hasError) return "broken";
  return body.connected ? "connected" : "not_connected";
}

// Student-facing copy. Describes what to do, never how the connection works.
const ERROR_MESSAGES: Readonly<Record<ConnectErrorCode, string>> = {
  invalid_credentials: "That email and password didn't work on Gradescope. Check them and try again.",
  sso_required:
    "Your school signs you in to Gradescope, so a password won't work here. Use the cookie steps instead.",
  session_expired:
    "That cookie didn't work. It may have expired. Sign in to Gradescope again, copy a fresh one, and paste it here.",
  bad_request: "Polya couldn't use what you entered. Check it and try again.",
  unavailable: "Polya can't reach Gradescope right now. Try again in a few minutes.",
  cookie_missing: "Paste your Gradescope cookie first.",
  cookie_too_long:
    "That's longer than a Gradescope cookie. Copy only the Cookie value and paste it again.",
  cookie_not_gradescope:
    "That doesn't look like a Gradescope cookie. Make sure you're signed in at gradescope.com, then copy the Cookie value again.",
  email_invalid: "Enter the email you use for Gradescope.",
  password_missing: "Enter your Gradescope password.",
  password_too_long: "That password is too long. Check it and try again.",
  signed_out: "You've been signed out of Polya.",
  timeout:
    "This is taking longer than usual. Reload this page in a minute to see whether Gradescope connected.",
  unknown: "That didn't go through. Try again in a moment.",
};

export function connectErrorMessage(code: ConnectErrorCode): string {
  return ERROR_MESSAGES[code];
}

const STATUS_SUMMARIES: Readonly<Record<GradescopeStatus, { title: string; body: string }>> = {
  connected: {
    title: "Gradescope is connected",
    body: "Reconnect here if Polya stops seeing your Gradescope assignments.",
  },
  broken: {
    title: "Gradescope needs reconnecting",
    body: "Polya couldn't reach your Gradescope account recently. Reconnect below to fix it.",
  },
  not_connected: {
    title: "Gradescope isn't connected",
    body: "Connect it below so Polya can see your Gradescope assignments.",
  },
  unknown: {
    title: "Couldn't check Gradescope right now",
    body: "You can still reconnect below.",
  },
};

export function statusSummary(status: GradescopeStatus): { title: string; body: string } {
  return STATUS_SUMMARIES[status];
}

/** The success screen's line about courses. */
export function connectedSummary(courses: number): string {
  if (courses <= 0) return "Polya doesn't see any courses in your Gradescope account yet.";
  return courses === 1 ? "Polya can see 1 course." : `Polya can see ${courses} courses.`;
}
