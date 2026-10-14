// platform-hardening 2.13 (Found by 2.13-Sol): polya-canvas's request guards,
// exercised through the real handler against a fake backend
// (_shared/test-serve.ts): POST-only, the body cap before parsing (with the
// refused body drained), and malformed JSON as a 400 rather than a 500.
//
// Run: deno test --allow-env --allow-read --no-check supabase/functions/polya-canvas/
import { assertEquals } from "jsr:@std/assert@1";
import { authRoute, jsonResponse, loadHandler, setBackend, TEST_USER_JWT } from "../_shared/test-serve.ts";
import { CANVAS_MAX_BODY_BYTES } from "../_shared/polya-rate-limits.ts";

const handler = await loadHandler(new URL("./index.ts", import.meta.url).href);
const URL_ = "http://polya.test/functions/v1/polya-canvas";

// Counts every outbound call; auth answers for TEST_USER_JWT, and the
// connections read answers with an empty list.
function backend(): { calls: string[] } {
  const log = { calls: [] as string[] };
  setBackend((url, request) => {
    log.calls.push(url.pathname);
    const auth = authRoute(url, request);
    if (auth) return auth;
    if (url.pathname.startsWith("/rest/v1/")) return jsonResponse([]);
    return null;
  });
  return log;
}

function post(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

Deno.test("polya-canvas: non-POST methods get 405; OPTIONS still answers the preflight", async () => {
  const log = backend();
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const response = await handler(new Request(URL_, { method }));
    assertEquals(response.status, 405, method);
    assertEquals((await response.json()).code, "method_not_allowed");
  }
  const preflight = await handler(new Request(URL_, { method: "OPTIONS" }));
  assertEquals(preflight.status, 200);
  await preflight.body?.cancel();
  assertEquals(log.calls.length, 0, "no backend call for a refused method");
});

Deno.test("polya-canvas: a declared Content-Length over the cap is a 413 before auth", async () => {
  const log = backend();
  const response = await handler(
    post(JSON.stringify({ action: "status" }), {
      Authorization: `Bearer ${TEST_USER_JWT}`,
      "Content-Length": String(CANVAS_MAX_BODY_BYTES + 1),
    }),
  );
  assertEquals(response.status, 413);
  assertEquals((await response.json()).code, "too_large");
  assertEquals(log.calls.length, 0, "nothing past the cap reaches auth or the database");
});

Deno.test("polya-canvas: a streamed body over the cap is a 413 and is drained", async () => {
  const log = backend();
  const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
  const chunks = Math.ceil((CANVAS_MAX_BODY_BYTES * 4) / chunk.byteLength);
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
  assertEquals(sent, chunks, "the refused body is read to the end so the response can be delivered");
  assertEquals(log.calls.length, 0, "nothing past the cap reaches auth or the database");
});

Deno.test("polya-canvas: malformed, empty or non-object JSON is a 400, not a 500", async () => {
  const log = backend();
  for (const body of ["{not json", "", "null", "42", "[]"]) {
    const response = await handler(post(body, { Authorization: `Bearer ${TEST_USER_JWT}` }));
    assertEquals(response.status, 400, JSON.stringify(body));
    assertEquals((await response.json()).code, "bad_request");
  }
  assertEquals(log.calls.length, 0, "a bad body never reaches auth or the database");
});

Deno.test("polya-canvas: a body under the cap still reaches auth (401 without a user)", async () => {
  backend();
  const response = await handler(post(JSON.stringify({ action: "status" })));
  assertEquals(response.status, 401);
  assertEquals((await response.json()).code, "unauthorized");
});

Deno.test("polya-canvas: a valid signed-in request passes the guards", async () => {
  backend();
  const response = await handler(
    post(JSON.stringify({ action: "status" }), { Authorization: `Bearer ${TEST_USER_JWT}` }),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { connections: [] });
});
