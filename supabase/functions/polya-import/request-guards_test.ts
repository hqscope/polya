// Phase 9 A-9: polya-import's request guards, exercised through the real
// handler against a fake backend (_shared/test-serve.ts): POST-only, the body
// cap before parsing, the constant-time pump secret / service-key check, and
// the hourly per-user window failing closed.
//
// Run: deno test --allow-env --allow-read --no-check supabase/functions/polya-import/
import { assertEquals } from "jsr:@std/assert@1";
import {
  authRoute,
  jsonResponse,
  loadHandler,
  rpcName,
  setBackend,
  TEST_PUMP_SECRET,
  TEST_SERVICE_ROLE_KEY,
  TEST_USER_ID,
  TEST_USER_JWT,
} from "../_shared/test-serve.ts";
import { IMPORT_HOURLY_LIMITS, IMPORT_MAX_BODY_BYTES } from "../_shared/polya-rate-limits.ts";

const handler = await loadHandler(new URL("./index.ts", import.meta.url).href);
const URL_ = "http://polya.test/functions/v1/polya-import";

type RpcCall = { name: string; args: Record<string, unknown> };

// Records every RPC and answers it with `answer(name)`; auth is answered for
// TEST_USER_JWT. Returns the call log.
function backend(answer: (name: string) => Response): RpcCall[] {
  const calls: RpcCall[] = [];
  setBackend(async (url, request) => {
    const auth = authRoute(url, request);
    if (auth) return auth;
    const name = rpcName(url);
    if (!name) return null;
    calls.push({ name, args: (await request.json()) as Record<string, unknown> });
    return answer(name);
  });
  return calls;
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

function asUser(body: unknown): Request {
  return post(JSON.stringify(body), { Authorization: `Bearer ${TEST_USER_JWT}` });
}

// --- method ----------------------------------------------------------------

Deno.test("non-POST methods get 405; OPTIONS still answers the preflight", async () => {
  backend(() => jsonResponse(null));
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const response = await handler(new Request(URL_, { method }));
    assertEquals(response.status, 405, method);
    assertEquals((await response.json()).code, "method_not_allowed");
  }
  const preflight = await handler(new Request(URL_, { method: "OPTIONS" }));
  assertEquals(preflight.status, 200);
  await preflight.body?.cancel();
});

// --- body cap --------------------------------------------------------------

Deno.test("a declared Content-Length over the cap is refused before reading", async () => {
  const calls = backend(() => jsonResponse(true));
  const response = await handler(
    post(JSON.stringify({ action: "status_all" }), {
      "Content-Length": String(IMPORT_MAX_BODY_BYTES + 1),
    }),
  );
  assertEquals(response.status, 413);
  assertEquals((await response.json()).code, "too_large");
  assertEquals(calls.length, 0, "nothing past the cap reaches the database");
});

Deno.test("a streamed body with no Content-Length over the cap is a 413", async () => {
  const calls = backend(() => jsonResponse(true));
  const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
  const chunks = Math.ceil((IMPORT_MAX_BODY_BYTES * 1.5) / chunk.byteLength);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent >= chunks) {
          controller.close();
          return;
        }
        sent++;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(URL_, {
    method: "POST",
    body: stream,
    // @ts-ignore: duplex is required for a streamed request body in Deno/undici.
    duplex: "half",
  });
  assertEquals(request.headers.get("content-length"), null);
  const response = await handler(request);
  assertEquals(response.status, 413);
  assertEquals((await response.json()).code, "too_large");
  assertEquals(sent, chunks, "the refused body is drained so the response can be delivered");
  assertEquals(calls.length, 0, "nothing past the cap reaches the database");
});

Deno.test("malformed, empty or non-object JSON is a 400, not a 500", async () => {
  backend(() => jsonResponse(true));
  for (const body of ["{not json", "", "null", "42"]) {
    const response = await handler(post(body));
    assertEquals(response.status, 400, JSON.stringify(body));
    assertEquals((await response.json()).code, "bad_request");
  }
});

// --- pump auth (constant-time compare) --------------------------------------

const PUMP = { action: "pump", user_id: TEST_USER_ID, lease_token: "lease" };

Deno.test("pump: no secret, a wrong secret, near misses and a user JWT are all 403", async () => {
  const calls = backend(() => jsonResponse(false));
  const attempts: Record<string, string>[] = [
    {},
    { "x-polya-pump-secret": "wrong" },
    { "x-polya-pump-secret": TEST_PUMP_SECRET.slice(0, -1) },
    { "x-polya-pump-secret": `${TEST_PUMP_SECRET}x` },
    { Authorization: `Bearer ${TEST_SERVICE_ROLE_KEY.slice(0, -1)}` },
    { Authorization: `Bearer ${TEST_USER_JWT}` },
  ];
  for (const headers of attempts) {
    const response = await handler(post(JSON.stringify(PUMP), headers));
    assertEquals(response.status, 403, JSON.stringify(headers));
    assertEquals((await response.json()).code, "forbidden");
  }
  assertEquals(calls.length, 0, "a refused pump never touches the database");
});

Deno.test("pump: the sweeper's secret and the service-role key are accepted", async () => {
  const accepted: Record<string, string>[] = [
    { "x-polya-pump-secret": TEST_PUMP_SECRET },
    { Authorization: `Bearer ${TEST_SERVICE_ROLE_KEY}` },
  ];
  for (const headers of accepted) {
    // Renewing the lease answers false, so the background drain exits at once.
    const calls = backend(() => jsonResponse(false));
    const response = await handler(post(JSON.stringify(PUMP), headers));
    assertEquals(response.status, 200, JSON.stringify(headers));
    assertEquals((await response.json()).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(calls.map((call) => call.name), ["polya_renew_import_lease"]);
  }
});

// --- hourly window (fails closed) -------------------------------------------

Deno.test("the hourly window refuses when the limiter errors, says no or returns nothing", async () => {
  const answers: Array<() => Response> = [
    () => jsonResponse({ message: "boom" }, 500),
    () => jsonResponse(false),
    () => jsonResponse(null),
  ];
  for (const answer of answers) {
    const calls = backend((name) => (name === "claim_rate_limit" ? answer() : jsonResponse(null)));
    const response = await handler(asUser({ action: "status_all" }));
    assertEquals(response.status, 429);
    assertEquals((await response.json()).code, "rate_limited");
    assertEquals(calls.map((call) => call.name), ["claim_rate_limit"], "nothing runs past the limiter");
  }
});

Deno.test("the window is claimed per user, per action class", async () => {
  const cases: Array<[string, string, number]> = [
    ["start", "polya-import:start:hour", IMPORT_HOURLY_LIMITS.start],
    ["extension_import_start", "polya-import:start:hour", IMPORT_HOURLY_LIMITS.start],
    ["kick", "polya-import:kick:hour", IMPORT_HOURLY_LIMITS.kick],
    ["status_all", "polya-import:hour", IMPORT_HOURLY_LIMITS.default],
  ];
  for (const [action, bucket, limit] of cases) {
    const calls = backend(() => jsonResponse(false));
    const response = await handler(asUser({ action }));
    assertEquals(response.status, 429, action);
    await response.body?.cancel();
    assertEquals(calls[0].args, {
      p_subject: `user:${TEST_USER_ID}`,
      p_bucket: bucket,
      p_limit: limit,
      p_window_seconds: 3600,
    });
  }
});

Deno.test("an allowed claim lets the action through", async () => {
  backend(() => jsonResponse(true));
  const response = await handler(asUser({ action: "no_such_action" }));
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, "Unknown action");
});

Deno.test("no user session is still a 401 (auth runs before the limiter)", async () => {
  const calls = backend(() => jsonResponse(true));
  const response = await handler(post(JSON.stringify({ action: "status_all" })));
  assertEquals(response.status, 401);
  await response.body?.cancel();
  assertEquals(calls.length, 0);
});
