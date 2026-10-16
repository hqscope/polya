import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AGENT_CONNECT_ENDPOINT,
  DEFAULT_AGENT_URL,
  GRADESCOPE_CONNECT_PATH,
  MAX_COOKIE_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
  agentConnectUrl,
  connectErrorMessage,
  connectRequestBody,
  connectedSummary,
  hasGradescopeSessionCookie,
  normalizeCookie,
  parseConnectForm,
  parseConnectResponse,
  parseStatusResponse,
  statusRequestBody,
  statusSummary,
  validateCookie,
  validateEmail,
  validatePassword,
  type ConnectErrorCode,
  type GradescopeStatus,
} from "../src/lib/gradescope-connect.ts";
import { loginPathFor, sanitizeNextPath } from "../src/lib/auth/next-path.ts";

const SITE = "https://askpolya.com";
const COOKIE = "signed_token=abc123; remember_me=xyz; _gradescope_session=def456";

test("the agent URL falls back to the default and drops trailing slashes", () => {
  const fallback = `${DEFAULT_AGENT_URL}${AGENT_CONNECT_ENDPOINT}`;
  assert.equal(agentConnectUrl(undefined), fallback);
  assert.equal(agentConnectUrl(null), fallback);
  assert.equal(agentConnectUrl(""), fallback);
  assert.equal(agentConnectUrl("   "), fallback);
  assert.equal(
    agentConnectUrl("https://agent.example/"),
    "https://agent.example/polya/gradescope/connect",
  );
  assert.equal(
    agentConnectUrl(" http://localhost:3001// "),
    "http://localhost:3001/polya/gradescope/connect",
  );
});

test("a pasted cookie is tidied before it's checked", () => {
  assert.equal(normalizeCookie(`  ${COOKIE}\n`), COOKIE);
  assert.equal(normalizeCookie(`Cookie: ${COOKIE}`), COOKIE);
  assert.equal(normalizeCookie(`cookie:${COOKIE}`), COOKIE);
  // A value that wrapped when it was copied is joined back up.
  assert.equal(normalizeCookie("signed_token=ab\r\nc123;\t_x=1"), "signed_token=abc123;_x=1");
});

test("a cookie needs signed_token or _gradescope_session with a value", () => {
  assert.equal(hasGradescopeSessionCookie(COOKIE), true);
  assert.equal(hasGradescopeSessionCookie("signed_token=abc"), true);
  assert.equal(hasGradescopeSessionCookie("_ga=1; _gradescope_session=def"), true);
  for (const cookie of [
    "",
    "remember_me=xyz",
    "signed_token=",
    "signed_token=  ; _gradescope_session=",
    "not_signed_token=abc",
    "x_gradescope_session=abc",
    "signed_token",
    "=signed_token=abc",
  ]) {
    assert.equal(hasGradescopeSessionCookie(cookie), false, JSON.stringify(cookie));
  }
});

test("a good cookie passes, tidied", () => {
  assert.deepEqual(validateCookie(COOKIE), { ok: true, cookie: COOKIE });
  assert.deepEqual(validateCookie(`Cookie: ${COOKIE}\n`), { ok: true, cookie: COOKIE });
});

test("a missing, oversized or foreign cookie is caught before sending", () => {
  assert.deepEqual(validateCookie(undefined), { ok: false, code: "cookie_missing" });
  assert.deepEqual(validateCookie(null), { ok: false, code: "cookie_missing" });
  assert.deepEqual(validateCookie(""), { ok: false, code: "cookie_missing" });
  assert.deepEqual(validateCookie(" \n\t"), { ok: false, code: "cookie_missing" });
  assert.deepEqual(validateCookie("Cookie: "), { ok: false, code: "cookie_missing" });

  const atCap = `signed_token=${"a".repeat(MAX_COOKIE_LENGTH - "signed_token=".length)}`;
  assert.equal(atCap.length, MAX_COOKIE_LENGTH);
  assert.equal(validateCookie(atCap).ok, true);
  assert.deepEqual(validateCookie(`${atCap}b`), { ok: false, code: "cookie_too_long" });
  assert.deepEqual(validateCookie("a".repeat(MAX_COOKIE_LENGTH * 2 + 1)), {
    ok: false,
    code: "cookie_too_long",
  });

  for (const raw of [
    "remember_me=xyz",
    "hello",
    "https://www.gradescope.com",
    "signed_token=abc\u0000",
    "signed_token=abc\u007f",
  ]) {
    assert.deepEqual(validateCookie(raw), { ok: false, code: "cookie_not_gradescope" }, JSON.stringify(raw));
  }
  // A File from FormData isn't a cookie.
  assert.deepEqual(validateCookie(new Blob(["x"])), { ok: false, code: "cookie_missing" });
});

test("emails are trimmed and checked; passwords are kept exactly", () => {
  assert.deepEqual(validateEmail("  oski@berkeley.edu "), { ok: true, email: "oski@berkeley.edu" });
  for (const raw of [undefined, null, "", "oski", "oski@", "@berkeley.edu", "oski@berkeley", "o ski@berkeley.edu"]) {
    assert.deepEqual(validateEmail(raw), { ok: false, code: "email_invalid" }, JSON.stringify(raw));
  }
  const long = `${"a".repeat(MAX_EMAIL_LENGTH)}@x.edu`;
  assert.deepEqual(validateEmail(long), { ok: false, code: "email_invalid" });

  assert.deepEqual(validatePassword(" pass word "), { ok: true, password: " pass word " });
  assert.deepEqual(validatePassword(""), { ok: false, code: "password_missing" });
  assert.deepEqual(validatePassword(null), { ok: false, code: "password_missing" });
  assert.equal(validatePassword("p".repeat(MAX_PASSWORD_LENGTH)).ok, true);
  assert.deepEqual(validatePassword("p".repeat(MAX_PASSWORD_LENGTH + 1)), {
    ok: false,
    code: "password_too_long",
  });
});

test("the form becomes a cookie or password request, or a code", () => {
  assert.deepEqual(parseConnectForm({ mode: "cookie", cookie: `${COOKIE}\n`, email: "x", password: "y" }), {
    ok: true,
    request: { mode: "cookie", cookie: COOKIE },
  });
  assert.deepEqual(
    parseConnectForm({ mode: "password", email: " oski@berkeley.edu ", password: "go bears", cookie: COOKIE }),
    { ok: true, request: { mode: "password", email: "oski@berkeley.edu", password: "go bears" } },
  );
  assert.deepEqual(parseConnectForm({ mode: "cookie", cookie: null }), { ok: false, code: "cookie_missing" });
  assert.deepEqual(parseConnectForm({ mode: "password", email: "nope", password: "x" }), {
    ok: false,
    code: "email_invalid",
  });
  assert.deepEqual(parseConnectForm({ mode: "password", email: "oski@berkeley.edu", password: "" }), {
    ok: false,
    code: "password_missing",
  });
  for (const mode of [null, undefined, "", "COOKIE", "status", "token"]) {
    assert.deepEqual(parseConnectForm({ mode, cookie: COOKIE }), { ok: false, code: "bad_request" }, String(mode));
  }
});

test("request bodies carry exactly what the agent expects", () => {
  assert.deepEqual(connectRequestBody("user-1", { mode: "cookie", cookie: COOKIE }), {
    user_id: "user-1",
    mode: "cookie",
    cookie: COOKIE,
  });
  assert.deepEqual(
    connectRequestBody("user-1", { mode: "password", email: "oski@berkeley.edu", password: "go bears" }),
    { user_id: "user-1", mode: "password", email: "oski@berkeley.edu", password: "go bears" },
  );
  assert.deepEqual(statusRequestBody("user-1"), { user_id: "user-1", action: "status" });
});

test("a successful connect reply gives the course count and names", () => {
  assert.deepEqual(
    parseConnectResponse(200, { ok: true, courses: 2, course_names: ["CS 61B", " Data C100 "] }),
    { ok: true, courses: 2, courseNames: ["CS 61B", "Data C100"] },
  );
  // Junk names are dropped; a missing count falls back to the names.
  assert.deepEqual(
    parseConnectResponse(200, { ok: true, course_names: ["CS 61B", 7, null, "  ", "MCB 102"] }),
    { ok: true, courses: 2, courseNames: ["CS 61B", "MCB 102"] },
  );
  assert.deepEqual(parseConnectResponse(200, { ok: true, courses: -1 }), {
    ok: true,
    courses: 0,
    courseNames: [],
  });
  assert.deepEqual(parseConnectResponse(200, { ok: true, courses: 1.5, course_names: "CS 61B" }), {
    ok: true,
    courses: 0,
    courseNames: [],
  });
  const many = Array.from({ length: 150 }, (_, i) => `Course ${i}`);
  const parsed = parseConnectResponse(200, { ok: true, courses: 150, course_names: many });
  assert.ok(parsed.ok);
  assert.equal(parsed.courses, 150);
  assert.equal(parsed.courseNames.length, 100);
  const long = parseConnectResponse(200, { ok: true, courses: 1, course_names: ["x".repeat(500)] });
  assert.ok(long.ok);
  assert.equal(long.courseNames[0]?.length, 200);
});

test("each agent error code comes through; anything else is unknown", () => {
  for (const code of ["invalid_credentials", "sso_required", "session_expired", "bad_request", "unavailable"]) {
    assert.deepEqual(parseConnectResponse(400, { ok: false, code, message: "raw detail" }), { ok: false, code });
    assert.deepEqual(parseConnectResponse(200, { ok: false, code }), { ok: false, code });
  }
  for (const [status, body] of [
    [401, { error: "unauthorized" }],
    [500, null],
    [502, "Bad Gateway"],
    [200, null],
    [200, []],
    [200, { ok: "true", courses: 1 }],
    [500, { ok: true, courses: 1 }],
    [400, { ok: false, code: "constructor" }],
    [400, { ok: false, code: "toString" }],
    [400, { ok: false }],
  ] as const) {
    assert.deepEqual(parseConnectResponse(status, body), { ok: false, code: "unknown" }, JSON.stringify([status, body]));
  }
});

test("the status reply says connected, needs reconnecting, not connected, or unknown", () => {
  assert.equal(parseStatusResponse(200, { ok: true, connected: true, last_error: null }), "connected");
  assert.equal(parseStatusResponse(200, { ok: true, connected: true }), "connected");
  assert.equal(parseStatusResponse(200, { ok: true, connected: true, last_error: "  " }), "connected");
  assert.equal(parseStatusResponse(200, { ok: true, connected: false, last_error: null }), "not_connected");
  assert.equal(
    parseStatusResponse(200, { ok: true, connected: false, last_error: "session_expired" }),
    "broken",
  );
  assert.equal(
    parseStatusResponse(200, { ok: true, connected: true, last_error: "Gradescope session expired" }),
    "broken",
  );
  assert.equal(parseStatusResponse(200, { ok: true, connected: true, last_error: { code: "x" } }), "broken");
  for (const [status, body] of [
    [500, { ok: true, connected: true }],
    [401, { ok: false, code: "unauthorized" }],
    [200, null],
    [200, { ok: false, code: "unavailable" }],
    [200, { ok: true }],
    [200, { ok: true, connected: "yes" }],
  ] as const) {
    assert.equal(parseStatusResponse(status, body), "unknown", JSON.stringify([status, body]));
  }
});

const ALL_CODES: ConnectErrorCode[] = [
  "invalid_credentials",
  "sso_required",
  "session_expired",
  "bad_request",
  "unavailable",
  "cookie_missing",
  "cookie_too_long",
  "cookie_not_gradescope",
  "email_invalid",
  "password_missing",
  "password_too_long",
  "signed_out",
  "timeout",
  "unknown",
];

// Copy rule (CLAUDE.md): describe the experience, never the mechanics.
const MECHANICS = /\b(token|session|server|api|agent|endpoint|http|json|request|header|sso|secret)\b/i;

test("every error has its own plain message", () => {
  const seen = new Set<string>();
  for (const code of ALL_CODES) {
    const message = connectErrorMessage(code);
    assert.ok(message.length > 0, code);
    assert.doesNotMatch(message, MECHANICS, code);
    assert.doesNotMatch(message, /\b(please|simply|just)\b|!/i, code);
    assert.ok(!seen.has(message), `${code} repeats another message`);
    seen.add(message);
  }
  assert.match(connectErrorMessage("sso_required"), /cookie steps/);
  assert.match(connectErrorMessage("session_expired"), /fresh one/);
});

test("every status has a title and a body in plain words", () => {
  for (const status of ["connected", "broken", "not_connected", "unknown"] satisfies GradescopeStatus[]) {
    const { title, body } = statusSummary(status);
    assert.ok(title.length > 0 && body.length > 0, status);
    assert.doesNotMatch(`${title} ${body}`, MECHANICS, status);
  }
});

test("the success line counts courses", () => {
  assert.equal(connectedSummary(1), "Polya can see 1 course.");
  assert.equal(connectedSummary(4), "Polya can see 4 courses.");
  assert.match(connectedSummary(0), /doesn't see any courses/);
});

test("sign-in comes back to this page", () => {
  assert.equal(GRADESCOPE_CONNECT_PATH, "/connect/gradescope");
  assert.equal(sanitizeNextPath(GRADESCOPE_CONNECT_PATH), GRADESCOPE_CONNECT_PATH);
  const next = new URL(loginPathFor(GRADESCOPE_CONNECT_PATH), SITE).searchParams.get("next");
  assert.equal(next, GRADESCOPE_CONNECT_PATH);
});

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("wiring: the action takes the student's id from the session, never the form", () => {
  const action = read("src/app/connect/gradescope/actions.ts");
  assert.match(action, /^"use server";/);
  assert.match(action, /await getAuthenticatedAppUser\(\)/);
  assert.match(action, /sendGradescopeConnect\(user\.id, parsed\.request\)/);
  assert.doesNotMatch(action, /formData\.get\("user_?id"\)/i);
  assert.doesNotMatch(action, /console\./);
});

test("wiring: the agent call is authorized, time-boxed, and logs no secrets", () => {
  const agent = read("src/app/connect/gradescope/agent.ts");
  assert.match(agent, /process\.env\.POLYA_CONNECT_SECRET/);
  assert.match(agent, /process\.env\.POLYA_IMESSAGE_AGENT_URL/);
  assert.match(agent, /Authorization: `Bearer \$\{config\.secret\}`/);
  assert.match(agent, /signal: AbortSignal\.timeout\(timeoutMs\)/);
  assert.match(agent, /CONNECT_TIMEOUT_MS\)/);
  assert.match(agent, /redirect: "error"/);
  // Log lines are one template string that names an HTTP status or an
  // error's name, nothing else.
  const logLines = agent.split("\n").filter((l) => l.includes("console."));
  assert.ok(logLines.length > 0);
  for (const line of logLines) {
    assert.match(line, /console\.warn\(`[^`]*`\);/, line.trim());
    for (const [, expression] of line.matchAll(/\$\{([^}]*)\}/g)) {
      assert.ok(["name", "reply.status"].includes(expression), line.trim());
    }
  }
  // The client form never imports the module that holds the secret.
  assert.doesNotMatch(read("src/app/connect/gradescope/GradescopeConnectForm.tsx"), /from "\.\/agent"/);
});

test("wiring: the page sends signed-out students to sign in and back", () => {
  const page = read("src/app/connect/gradescope/page.tsx");
  assert.match(page, /redirect\(loginPathFor\(GRADESCOPE_CONNECT_PATH\)\)/);
  assert.match(page, /isGradescopeConnectConfigured\(\)/);
  assert.match(page, /<OutageNotice fullScreen \/>/);
});
