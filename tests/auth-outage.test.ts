import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createServerClient } from "@supabase/ssr";

import { isAuthOutage, isDefiniteSignOut } from "../src/lib/auth/outage.ts";
import {
  AUTH_CALL_TIMEOUT_MS,
  AUTH_UNREACHABLE_CODE,
  classifyAuthCall,
  createFailFastAuthFetch,
} from "../src/lib/supabase/fail-fast-auth-fetch.ts";

function authError(status: number | undefined, code: string | undefined) {
  return { status, code } as Parameters<typeof isDefiniteSignOut>[0];
}

test("no error is neither a sign-out nor an outage", () => {
  assert.equal(isDefiniteSignOut(null), false);
  assert.equal(isDefiniteSignOut(undefined), false);
  assert.equal(isAuthOutage(null), false);
  assert.equal(isAuthOutage(undefined), false);
});

test("a 401 with a GoTrue code is a definite sign-out, not an outage", () => {
  for (const code of [
    "session_not_found",
    "session_expired",
    "refresh_token_not_found",
    "refresh_token_already_used",
  ]) {
    const error = authError(401, code);
    assert.equal(isDefiniteSignOut(error), true, code);
    assert.equal(isAuthOutage(error), false, code);
  }
});

test("a 402 (over quota) is an outage, never a sign-out", () => {
  const error = authError(402, undefined);
  assert.equal(isDefiniteSignOut(error), false);
  assert.equal(isAuthOutage(error), true);
});

test("a 5xx is an outage, never a sign-out", () => {
  for (const status of [500, 502, 503, 504]) {
    const error = authError(status, "unexpected_failure");
    assert.equal(isDefiniteSignOut(error), false, String(status));
    assert.equal(isAuthOutage(error), true, String(status));
  }
});

test("a network/retryable failure with no status is an outage", () => {
  const error = authError(undefined, undefined);
  assert.equal(isDefiniteSignOut(error), false);
  assert.equal(isAuthOutage(error), true);
});

test("a 401 with no code (unexpected shape) is treated as an outage, not a sign-out", () => {
  const error = authError(401, undefined);
  assert.equal(isDefiniteSignOut(error), false);
  assert.equal(isAuthOutage(error), true);
});

// What auth-js actually returns when there are no session cookies at all:
// `new AuthSessionMissingError()` (status 400, no code). No request is made,
// so it can't be an outage. Before this case, every signed-out visit to /app
// was classed as an outage and crashed the page.
test("no session at all (AuthSessionMissingError) is a sign-out, never an outage", () => {
  const error = {
    name: "AuthSessionMissingError",
    message: "Auth session missing!",
    status: 400,
    code: undefined,
  } as unknown as Parameters<typeof isDefiniteSignOut>[0];
  assert.equal(isDefiniteSignOut(error), true);
  assert.equal(isAuthOutage(error), false);
});

// GoTrue's real rejections of a stale session aren't 401s: a dead refresh
// token is 400 (`refresh_token_not_found`, `refresh_token_already_used`), and
// a bad or orphaned access token is 403 (`bad_jwt`, `session_not_found`,
// `user_not_found`). The Scope extension's guard accepts the same statuses.
test("GoTrue's 400/403 rejections with a code are sign-outs, not outages", () => {
  const cases: Array<[number, string]> = [
    [400, "refresh_token_not_found"],
    [400, "refresh_token_already_used"],
    [403, "bad_jwt"],
    [403, "session_not_found"],
    [403, "user_not_found"],
  ];
  for (const [status, code] of cases) {
    const error = authError(status, code);
    assert.equal(isDefiniteSignOut(error), true, `${status} ${code}`);
    assert.equal(isAuthOutage(error), false, `${status} ${code}`);
  }
});

test("a 400/403 with no code, a 429 and a 402 with a code stay outages", () => {
  for (const [status, code] of [
    [400, undefined],
    [403, undefined],
    [429, "over_request_rate_limit"],
    [402, "exceed_storage_size_quota"],
  ] as Array<[number, string | undefined]>) {
    const error = authError(status, code);
    assert.equal(isDefiniteSignOut(error), false, `${status} ${code}`);
    assert.equal(isAuthOutage(error), true, `${status} ${code}`);
  }
});

// ---------------------------------------------------------------------------
// P-36: an expired session during an outage fails fast.
//
// These run the real server client (`@supabase/ssr` + auth-js) against a
// stubbed fetch, with the session in a cookie the way the browser sends it.
// ---------------------------------------------------------------------------

const STUB_URL = "http://127.0.0.1:3199";
const TOKEN_PATH = "/auth/v1/token";
const USER_PATH = "/auth/v1/user";

type StubAnswer = (url: URL, init: RequestInit | undefined) => Promise<Response>;

function sessionCookie(expired: boolean) {
  const now = Math.floor(Date.now() / 1000);
  const session = {
    access_token: "stub.access.token",
    refresh_token: "stub-refresh-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expired ? now - 3600 : now + 3600,
    user: { id: "user-1", email: "student@example.edu" },
  };
  return {
    name: "sb-127-auth-token",
    value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`,
  };
}

// GoTrue's answers carry this header; auth-js only reads `code` from a body
// when it's present, so the wrapper must keep response headers intact.
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
  });
}

const freshSession = () =>
  json(200, {
    access_token: "stub.access.token.2",
    refresh_token: "stub-refresh-token-2",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "user-1", email: "student@example.edu" },
  });

const userBody = () => json(200, { id: "user-1", email: "student@example.edu", aud: "authenticated" });

// Waits until the request is aborted (the wrapper's timeout), like a
// connection that never answers.
const hang: StubAnswer = (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // would hang forever; the tests always pass a signal through the wrapper
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

function stubBackend(answers: { token?: StubAnswer; user?: StubAnswer }) {
  const calls: string[] = [];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === TOKEN_PATH && answers.token) return answers.token(url, init);
    if (url.pathname === USER_PATH && answers.user) return answers.user(url, init);
    return json(404, { msg: "not stubbed" });
  };
  return { calls, fetchStub };
}

async function getUserWith(options: {
  fetch: typeof fetch;
  expired: boolean;
}) {
  const cookieWrites: Array<{ name: string; value: string }> = [];
  const client = createServerClient(STUB_URL, "stub-anon-key", {
    global: { fetch: options.fetch },
    cookies: {
      getAll: () => [sessionCookie(options.expired)],
      // Production's Server Component `setAll` swallows the write (Next
      // throws there); record what auth-js tried so tests can see it.
      setAll: (toSet) => {
        cookieWrites.push(...toSet.map(({ name, value }) => ({ name, value })));
      },
    },
  });
  const startedAt = performance.now();
  const result = await client.auth.getUser();
  return { ...result, elapsedMs: performance.now() - startedAt, cookieWrites };
}

function refreshCalls(calls: string[]) {
  return calls.filter((call) => call.startsWith(`POST ${TOKEN_PATH}?grant_type=refresh_token`));
}

// auth-js logs failed auth requests; keep the test output readable.
function quietConsole() {
  const error = mock.method(console, "error", () => undefined);
  const warn = mock.method(console, "warn", () => undefined);
  return () => {
    error.mock.restore();
    warn.mock.restore();
  };
}

test("control: without the wrapper, an expired session during a 503 retries for ~25 s", async () => {
  const restore = quietConsole();
  const { calls, fetchStub } = stubBackend({
    token: async () => new Response("<html>503 Service Unavailable</html>", { status: 503 }),
  });
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const client = createServerClient(STUB_URL, "stub-anon-key", {
      global: { fetch: fetchStub as typeof fetch },
      cookies: { getAll: () => [sessionCookie(true)], setAll: () => undefined },
    });
    const startedAt = Date.now();
    let settled = false;
    const pending = client.auth.getUser().finally(() => {
      settled = true;
    });
    for (let i = 0; i < 600 && !settled; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(100);
    }
    const { error } = await pending;
    const waitedMs = Date.now() - startedAt;
    assert.ok(waitedMs >= 20_000, `waited ${waitedMs} ms (mock clock)`);
    assert.ok(refreshCalls(calls).length >= 6, `${refreshCalls(calls).length} refresh calls`);
    assert.equal(isAuthOutage(error), true);
  } finally {
    mock.timers.reset();
    restore();
  }
});

test("an expired session during an outage fails fast, once, as an outage (5xx and network failures)", async () => {
  const restore = quietConsole();
  try {
    const failures: Array<[string, StubAnswer]> = [
      ...[500, 501, 502, 503, 504, 520, 522, 530].map(
        (status) =>
          [
            `HTTP ${status}`,
            async () => new Response(`<html>${status}</html>`, { status }),
          ] as [string, StubAnswer],
      ),
      ["503 with a JSON body", async () => json(503, { code: "unexpected_failure", msg: "down" })],
      [
        "network failure",
        async () => {
          throw new TypeError("fetch failed");
        },
      ],
    ];
    for (const [label, token] of failures) {
      const { calls, fetchStub } = stubBackend({ token });
      const { data, error, elapsedMs, cookieWrites } = await getUserWith({
        fetch: createFailFastAuthFetch(fetchStub),
        expired: true,
      });
      assert.ok(elapsedMs < 1000, `${label}: took ${elapsedMs} ms`);
      assert.equal(refreshCalls(calls).length, 1, `${label}: ${calls.join(", ")}`);
      assert.equal(data.user, null, label);
      assert.equal(isAuthOutage(error), true, label);
      assert.equal(isDefiniteSignOut(error), false, label);
      assert.equal(error?.status, 408, label);
      assert.equal(error?.code, AUTH_UNREACHABLE_CODE, label);
      // No new session is ever written. (auth-js may drop the expired one from
      // its storage, the same as after a 402; the Server Component can't
      // write that through, and the proxy forwards the original cookies.)
      assert.ok(
        cookieWrites.every((cookie) => cookie.value === ""),
        `${label}: ${JSON.stringify(cookieWrites)}`,
      );
    }
  } finally {
    restore();
  }
});

test("a refresh that never answers gives up at the timeout, as an outage", async () => {
  const restore = quietConsole();
  try {
    const { calls, fetchStub } = stubBackend({ token: hang });
    const { error, elapsedMs } = await getUserWith({
      fetch: createFailFastAuthFetch(fetchStub, 200),
      expired: true,
    });
    assert.ok(elapsedMs >= 150 && elapsedMs < 1200, `took ${elapsedMs} ms`);
    assert.equal(refreshCalls(calls).length, 1);
    assert.equal(isAuthOutage(error), true);
    assert.equal(error?.code, AUTH_UNREACHABLE_CODE);
  } finally {
    restore();
  }
});

test("a refresh whose body stalls after the headers also gives up at the timeout", async () => {
  const restore = quietConsole();
  try {
    const stalledBody: StubAnswer = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
              once: true,
            });
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const { calls, fetchStub } = stubBackend({ token: stalledBody });
    const { error, elapsedMs } = await getUserWith({
      fetch: createFailFastAuthFetch(fetchStub, 200),
      expired: true,
    });
    assert.ok(elapsedMs < 1200, `took ${elapsedMs} ms`);
    assert.equal(refreshCalls(calls).length, 1);
    assert.equal(isAuthOutage(error), true);
  } finally {
    restore();
  }
});

test("the quota outage (402) and real GoTrue rejections come through untouched", async () => {
  const restore = quietConsole();
  try {
    // 402: an outage, as before (auth-js never retried it).
    {
      const { calls, fetchStub } = stubBackend({
        token: async () => json(402, { code: "exceed_egress_quota", msg: "over quota" }),
      });
      const { error } = await getUserWith({ fetch: createFailFastAuthFetch(fetchStub), expired: true });
      assert.equal(refreshCalls(calls).length, 1);
      assert.equal(error?.status, 402);
      assert.equal(isAuthOutage(error), true);
    }
    // A dead refresh token and a reused one: definite sign-outs, as before.
    for (const code of ["refresh_token_not_found", "refresh_token_already_used"]) {
      const { calls, fetchStub } = stubBackend({
        token: async () => json(400, { code, msg: "Invalid Refresh Token" }),
      });
      const { error } = await getUserWith({ fetch: createFailFastAuthFetch(fetchStub), expired: true });
      assert.equal(refreshCalls(calls).length, 1, code);
      assert.equal(error?.status, 400, code);
      assert.equal(error?.code, code, code);
      assert.equal(isDefiniteSignOut(error), true, code);
      assert.equal(isAuthOutage(error), false, code);
    }
    // A bad access token on an unexpired session: GoTrue's 403 still signs out.
    {
      const { fetchStub } = stubBackend({
        user: async () => json(403, { code: "bad_jwt", msg: "invalid JWT" }),
      });
      const { error } = await getUserWith({ fetch: createFailFastAuthFetch(fetchStub), expired: false });
      assert.equal(error?.status, 403);
      assert.equal(isDefiniteSignOut(error), true);
    }
  } finally {
    restore();
  }
});

test("an unexpired session during an outage stays fast, and a hung user lookup is bounded", async () => {
  const restore = quietConsole();
  try {
    {
      const { calls, fetchStub } = stubBackend({
        user: async () => new Response("<html>503</html>", { status: 503 }),
      });
      const { error, elapsedMs } = await getUserWith({
        fetch: createFailFastAuthFetch(fetchStub),
        expired: false,
      });
      assert.ok(elapsedMs < 1000, `took ${elapsedMs} ms`);
      assert.equal(refreshCalls(calls).length, 0);
      assert.equal(isAuthOutage(error), true);
    }
    {
      const { fetchStub } = stubBackend({ user: hang });
      const { error, elapsedMs } = await getUserWith({
        fetch: createFailFastAuthFetch(fetchStub, 200),
        expired: false,
      });
      assert.ok(elapsedMs >= 150 && elapsedMs < 1200, `took ${elapsedMs} ms`);
      assert.equal(isAuthOutage(error), true);
    }
  } finally {
    restore();
  }
});

test("healthy: an expired session refreshes and the user loads, as before", async () => {
  const { calls, fetchStub } = stubBackend({ token: async () => freshSession(), user: async () => userBody() });
  const { data, error, cookieWrites } = await getUserWith({
    fetch: createFailFastAuthFetch(fetchStub),
    expired: true,
  });
  assert.equal(error, null);
  assert.equal(data.user?.id, "user-1");
  assert.equal(refreshCalls(calls).length, 1);
  // The refreshed session is handed to setAll as usual.
  assert.ok(cookieWrites.some((cookie) => cookie.value.startsWith("base64-")));

  const unexpired = stubBackend({ user: async () => userBody() });
  const second = await getUserWith({ fetch: createFailFastAuthFetch(unexpired.fetchStub), expired: false });
  assert.equal(second.error, null);
  assert.equal(second.data.user?.id, "user-1");
  assert.equal(refreshCalls(unexpired.calls).length, 0);
});

test("only the refresh and user lookups are touched; everything else passes through as is", async () => {
  const seen: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
  const base = async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), signal: init?.signal });
    return new Response("<html>503</html>", { status: 503 });
  };
  const wrapped = createFailFastAuthFetch(base);

  // Data queries and the sign-in code exchange keep their own answer and signal.
  for (const [url, method] of [
    [`${STUB_URL}/rest/v1/polya_courses?select=id`, "GET"],
    [`${STUB_URL}${TOKEN_PATH}?grant_type=pkce`, "POST"],
    [`${STUB_URL}/auth/v1/logout?scope=local`, "POST"],
    [`${STUB_URL}${TOKEN_PATH}?grant_type=refresh_token`, "GET"],
  ] as const) {
    seen.length = 0;
    const response = await wrapped(url, { method });
    assert.equal(response.status, 503, url);
    assert.equal(seen[0]?.signal, undefined, `${method} ${url} got a timeout`);
  }

  assert.equal(classifyAuthCall(`${STUB_URL}${TOKEN_PATH}?grant_type=refresh_token`, { method: "POST" }), "refresh");
  assert.equal(classifyAuthCall(`${STUB_URL}${USER_PATH}`), "user");
  assert.equal(classifyAuthCall(`${STUB_URL}${USER_PATH}`, { method: "PUT" }), "other");
  assert.equal(classifyAuthCall("not a url"), "other");
});

test("a caller's own abort is passed through, not turned into an outage answer", async () => {
  const controller = new AbortController();
  const wrapped = createFailFastAuthFetch((_input, init) => hang(new URL(STUB_URL), init), 5000);
  const pending = wrapped(`${STUB_URL}${TOKEN_PATH}?grant_type=refresh_token`, {
    method: "POST",
    signal: controller.signal,
  });
  controller.abort(new Error("caller gave up"));
  await assert.rejects(pending, /caller gave up/);
});

test("the per-call budget keeps the notice within ~3 s", () => {
  assert.ok(AUTH_CALL_TIMEOUT_MS > 0 && AUTH_CALL_TIMEOUT_MS <= 3000, String(AUTH_CALL_TIMEOUT_MS));
});

test("wiring: the Server Component client uses the wrapper; cookie-writing route handlers don't", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const serverComponent = read("src/lib/supabase/server-component.ts");
  assert.match(serverComponent, /createFailFastAuthFetch\(\)/);
  assert.match(serverComponent, /global:\s*\{\s*fetch:\s*failFastAuthFetch\s*\}/);
  // A non-retryable refresh failure makes auth-js drop an expired session from
  // storage; in a route handler that would clear the browser's cookies.
  assert.doesNotMatch(read("src/lib/supabase/server.ts"), /FailFastAuthFetch/);
});
