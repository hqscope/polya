import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GradescopeError } from "../agent/lib/gradescope/client.ts";
import {
  CONNECT_LIMITS,
  ConnectInputError,
  handleGradescopeConnect,
  parseConnectRequest,
  signInToGradescope,
  type ConnectDeps,
  type SignedIn,
  type SignInRequest,
} from "../agent/lib/gradescope/connect.ts";
import type { SaveConnectionInput } from "../agent/lib/gradescope/store.ts";
import type { GsCourse } from "../agent/lib/gradescope/types.ts";

const SECRET = "s".repeat(40);
const USER = "11111111-1111-4111-8111-111111111111";
const PASSWORD = "hunter2-very-secret";
const COOKIE = "signed_token=tok-secret; _gradescope_session=sess-secret";

function course(id: string, role: GsCourse["role"] = "student"): GsCourse {
  return { course_id: id, short_name: `C ${id}`, name: `Course ${id}`, term: "Fall 2026", role };
}

const SIGNED_IN: SignedIn = {
  session: { cookies: [], csrf_token: null, saved_at: "2026-10-15T16:00:00.000Z" },
  courses: [course("1"), course("2", "instructor"), course("3")],
};

interface Fake {
  deps: ConnectDeps;
  signIns: SignInRequest[];
  saves: { userId: string; input: SaveConnectionInput }[];
  afterConnect: string[];
  logs: string[];
}

function fake(overrides: Partial<ConnectDeps> = {}): Fake {
  const f: Fake = {
    signIns: [],
    saves: [],
    afterConnect: [],
    logs: [],
    deps: {
      secret: SECRET,
      checkReady: () => undefined,
      signIn: async (req) => {
        f.signIns.push(req);
        return SIGNED_IN;
      },
      save: async (userId, input) => {
        f.saves.push({ userId, input });
      },
      status: async () => ({ connected: true, last_error: null }),
      afterConnect: async (userId) => {
        f.afterConnect.push(userId);
      },
      logError: (message, details) => {
        f.logs.push(`${message} ${JSON.stringify(details)}`);
      },
      ...overrides,
    },
  };
  return f;
}

function post(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }): Request {
  return new Request("https://agent.example/polya/gradescope/connect", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function call(f: Fake, request: Request): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const res = await handleGradescopeConnect(request, f.deps);
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

describe("gradescope connect route: auth", () => {
  it("refuses a missing or wrong bearer token before reading the body", async () => {
    const f = fake();
    const attempts: Record<string, string>[] = [{}, { authorization: "Bearer nope" }, { authorization: SECRET }, { authorization: `Basic ${SECRET}` }];
    for (const headers of attempts) {
      const res = await call(f, post({ user_id: USER, action: "status" }, headers));
      assert.equal(res.status, 401);
      assert.equal(res.body.ok, false);
    }
    assert.equal(f.signIns.length, 0);
  });

  it("refuses everything when the secret is unset or shorter than 32 characters", async () => {
    for (const secret of [undefined, "", "short-secret"]) {
      const f = fake({ secret });
      const res = await call(f, post({ user_id: USER, action: "status" }, { authorization: `Bearer ${secret ?? ""}` }));
      assert.equal(res.status, 401);
    }
  });

  it("accepts the right token", async () => {
    const res = await call(fake(), post({ user_id: USER, action: "status" }));
    assert.equal(res.status, 200);
  });
});

describe("gradescope connect route: input", () => {
  async function badRequest(body: unknown): Promise<string> {
    const f = fake();
    const res = await call(f, post(body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, "bad_request");
    assert.equal(f.signIns.length, 0);
    return String(res.body.message);
  }

  it("rejects bodies that aren't a JSON object", async () => {
    await badRequest("not json");
    await badRequest([1, 2]);
    await badRequest(null);
  });

  it("rejects an oversized body", async () => {
    await badRequest({ user_id: USER, mode: "cookie", cookie: "x".repeat(CONNECT_LIMITS.bodyBytes + 10) });
  });

  it("rejects a bad user_id, mode, or action", async () => {
    assert.match(await badRequest({ user_id: "not-a-uuid", mode: "cookie", cookie: COOKIE }), /user_id/);
    assert.match(await badRequest({ mode: "cookie", cookie: COOKIE }), /user_id is required/);
    assert.match(await badRequest({ user_id: USER, mode: "magic" }), /mode/);
    assert.match(await badRequest({ user_id: USER, action: "delete" }), /action/);
  });

  it("requires the fields each mode needs", async () => {
    assert.match(await badRequest({ user_id: USER, mode: "cookie" }), /cookie is required/);
    assert.match(await badRequest({ user_id: USER, mode: "cookie", cookie: "   " }), /cookie is required/);
    assert.match(await badRequest({ user_id: USER, mode: "password", password: PASSWORD }), /email is required/);
    assert.match(await badRequest({ user_id: USER, mode: "password", email: "a@b.edu" }), /password is required/);
  });

  it("caps field lengths without echoing the value", async () => {
    const long = "p".repeat(CONNECT_LIMITS.passwordChars + 1);
    const message = await badRequest({ user_id: USER, mode: "password", email: "a@b.edu", password: long });
    assert.match(message, /password is too long/);
    assert.ok(!message.includes(long));
    assert.match(await badRequest({ user_id: USER, mode: "cookie", cookie: "c".repeat(CONNECT_LIMITS.cookieChars + 1) }), /cookie is too long/);
    assert.match(await badRequest({ user_id: USER, mode: "password", email: `${"e".repeat(CONNECT_LIMITS.emailChars)}@b.edu`, password: "x" }), /email is too long/);
  });

  it("drops a password sent in cookie mode", () => {
    const parsed = parseConnectRequest({ user_id: USER, mode: "cookie", cookie: ` ${COOKIE} `, password: PASSWORD, email: "" });
    assert.deepEqual(parsed, { ok: true, request: { kind: "cookie", userId: USER, cookie: COOKIE, email: null } });
  });
});

describe("gradescope connect route: connecting", () => {
  it("saves a password connection with the password, and returns student courses", async () => {
    const f = fake();
    const res = await call(f, post({ user_id: USER, mode: "password", email: " a@b.edu ", password: PASSWORD }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, courses: 2, course_names: ["C 1", "C 3"] });
    assert.deepEqual(f.signIns, [{ kind: "password", userId: USER, email: "a@b.edu", password: PASSWORD }]);
    assert.equal(f.saves[0]?.userId, USER);
    assert.equal(f.saves[0]?.input.password, PASSWORD);
    assert.equal(f.saves[0]?.input.email, "a@b.edu");
    assert.deepEqual(f.afterConnect, [USER]);
    assert.ok(!res.text.includes(PASSWORD));
  });

  it("never stores a password in cookie mode", async () => {
    const f = fake();
    const res = await call(f, post({ user_id: USER, mode: "cookie", cookie: COOKIE }));
    assert.equal(res.status, 200);
    assert.equal(f.saves[0]?.input.password, null);
    assert.equal(f.saves[0]?.input.email, null);
    assert.ok(!res.text.includes("tok-secret"));
  });

  it("returns at most 30 course names", async () => {
    const many: SignedIn = { ...SIGNED_IN, courses: Array.from({ length: 40 }, (_, i) => course(String(i))) };
    const res = await call(fake({ signIn: async () => many }), post({ user_id: USER, mode: "cookie", cookie: COOKIE }));
    assert.equal(res.body.courses, 40);
    assert.equal((res.body.course_names as string[]).length, 30);
  });

  it("maps sign-in failures to the page's codes", async () => {
    const cases: [unknown, number, string][] = [
      [new GradescopeError("invalid_credentials", "x"), 422, "invalid_credentials"],
      [new GradescopeError("login_failed", "x"), 422, "invalid_credentials"],
      [new GradescopeError("sso_required", "x"), 422, "sso_required"],
      [new GradescopeError("session_expired", "x"), 422, "session_expired"],
      [new ConnectInputError("no cookies"), 422, "session_expired"],
      [new GradescopeError("network", "x"), 503, "unavailable"],
      [new GradescopeError("http", "x"), 503, "unavailable"],
      [new Error("boom"), 503, "unavailable"],
    ];
    for (const [error, status, code] of cases) {
      const f = fake({
        signIn: async () => {
          throw error;
        },
      });
      const res = await call(f, post({ user_id: USER, mode: "password", email: "a@b.edu", password: PASSWORD }));
      assert.equal(res.status, status, code);
      assert.equal(res.body.code, code);
      assert.equal(typeof res.body.message, "string");
      assert.equal(f.saves.length, 0);
      assert.equal(f.afterConnect.length, 0);
      assert.ok(!f.logs.join("\n").includes(PASSWORD), "the password is never logged");
    }
  });

  it("answers 503 when the connection can't be stored", async () => {
    const notReady = await call(
      fake({
        checkReady: () => {
          throw new Error("GRADESCOPE_SECRET_KEY is not set");
        },
      }),
      post({ user_id: USER, mode: "cookie", cookie: COOKIE }),
    );
    assert.equal(notReady.status, 503);

    const f = fake({
      save: async () => {
        throw new Error("db down");
      },
    });
    const saveFailed = await call(f, post({ user_id: USER, mode: "cookie", cookie: COOKIE }));
    assert.equal(saveFailed.status, 503);
    assert.equal(saveFailed.body.code, "unavailable");
    assert.equal(f.afterConnect.length, 0);
  });
});

describe("gradescope connect route: status", () => {
  it("returns the saved connection's state", async () => {
    const f = fake({ status: async () => ({ connected: false, last_error: "session_expired: expired" }) });
    const res = await call(f, post({ user_id: USER, action: "status" }));
    assert.deepEqual(res.body, { ok: true, connected: false, last_error: "session_expired: expired" });
    assert.equal(f.signIns.length, 0);
  });

  it("answers 503 when the state can't be read", async () => {
    const res = await call(
      fake({
        status: async () => {
          throw new Error("db down");
        },
      }),
      post({ user_id: USER, action: "status" }),
    );
    assert.equal(res.status, 503);
  });
});

describe("signInToGradescope", () => {
  const ACCOUNT_HTML = `<html><body><a href="/logout">Log Out</a><div id="account-show">
    <div class="courseList"><div class="courseList--term">Fall 2026</div>
    <a class="courseBox" href="/courses/555"><h3 class="courseBox--shortname">MATH 53</h3><div class="courseBox--name">Calculus</div></a>
    </div></div></body></html>`;

  function fetchReturning(page: () => Response): typeof fetch {
    return (async () => page()) as typeof fetch;
  }

  it("rejects a paste with no Gradescope sign-in cookies without calling Gradescope", async () => {
    let calls = 0;
    const counting = fetchReturning(() => {
      calls += 1;
      return new Response("");
    });
    await assert.rejects(
      signInToGradescope({ kind: "cookie", userId: USER, cookie: "foo=bar", email: null }, { fetch: counting, minIntervalMs: 0 }),
      ConnectInputError,
    );
    assert.equal(calls, 0);
  });

  it("calls a cookie Gradescope doesn't accept expired", async () => {
    const fetch = fetchReturning(() => new Response(null, { status: 302, headers: { location: "https://sso.example.edu/login" } }));
    await assert.rejects(
      signInToGradescope({ kind: "cookie", userId: USER, cookie: COOKIE, email: null }, { fetch, minIntervalMs: 0 }),
      (error: unknown) => error instanceof GradescopeError && error.code === "session_expired",
    );
  });

  it("verifies a working cookie and lists its courses", async () => {
    const fetch = fetchReturning(() => new Response(ACCOUNT_HTML, { status: 200 }));
    const signedIn = await signInToGradescope({ kind: "cookie", userId: USER, cookie: COOKIE, email: null }, { fetch, minIntervalMs: 0 });
    assert.deepEqual(
      signedIn.courses.map((c) => c.short_name),
      ["MATH 53"],
    );
    assert.deepEqual(signedIn.session.cookies.map((c) => c.name).sort(), ["_gradescope_session", "signed_token"]);
  });
});
