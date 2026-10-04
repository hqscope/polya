// Phase 9 A-9: the body cap polya-import applies before parsing.
import { assertEquals } from "jsr:@std/assert@1";
import { readJsonCapped } from "./read-json-capped.ts";

const URL_ = "https://example.invalid/fn";

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(URL_, { method: "POST", headers, body });
}

Deno.test("a body within the cap parses", async () => {
  const result = await readJsonCapped(post(JSON.stringify({ action: "status_all" })), 1024);
  assertEquals(result, { ok: true, value: { action: "status_all" } });
});

Deno.test("a body exactly at the cap parses; one byte over is refused", async () => {
  const exact = JSON.stringify({ pad: "x".repeat(100) });
  assertEquals((await readJsonCapped(post(exact), exact.length)).ok, true);
  const over = await readJsonCapped(post(exact), exact.length - 1);
  assertEquals(over, { ok: false, status: 413, code: "too_large" });
});

Deno.test("a declared Content-Length over the cap is refused without parsing, and the body is drained", async () => {
  // The edge runtime only delivers a response once the request body has been
  // read, so a refused body is read to the end and discarded, not left unread.
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        if (pulls > 5) {
          controller.close();
          return;
        }
        // Valid JSON if anything parsed it: still refused, because of the cap.
        controller.enqueue(new TextEncoder().encode(pulls === 1 ? '{"a":1}' : " "));
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(URL_, {
    method: "POST",
    headers: { "Content-Length": "5000" },
    body: stream,
    // @ts-ignore: duplex is required for a streamed request body.
    duplex: "half",
  });
  const result = await readJsonCapped(request, 1024);
  assertEquals(result, { ok: false, status: 413, code: "too_large" });
  assertEquals(pulls, 6, "read to the end (5 chunks + close)");
});

Deno.test("a chunked body with no Content-Length is refused once it passes the cap, then drained", async () => {
  const chunk = new TextEncoder().encode("x".repeat(1000));
  const total = 50;
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent >= total) {
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
    // @ts-ignore: duplex is required for a streamed request body.
    duplex: "half",
  });
  const result = await readJsonCapped(request, 10_000);
  assertEquals(result, { ok: false, status: 413, code: "too_large" });
  assertEquals(sent, total, "the rest of the body was read and discarded");
});

Deno.test("a Content-Length smaller than the real body can't sneak more through", async () => {
  // A lying header passes the first check; the streamed count still stops it.
  const body = JSON.stringify({ pad: "x".repeat(5000) });
  const request = new Request(URL_, {
    method: "POST",
    headers: { "Content-Length": "10" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    // @ts-ignore: duplex is required for a streamed request body.
    duplex: "half",
  });
  assertEquals(await readJsonCapped(request, 1024), { ok: false, status: 413, code: "too_large" });
});

Deno.test("malformed, empty and garbage-length bodies are 400s", async () => {
  const invalid = { ok: false, status: 400, code: "bad_request" } as const;
  assertEquals(await readJsonCapped(post("{not json"), 1024), invalid);
  assertEquals(await readJsonCapped(post(""), 1024), invalid);
  assertEquals(await readJsonCapped(post(null), 1024), invalid);
  assertEquals(await readJsonCapped(post("{}", { "Content-Length": "abc" }), 1024), invalid);
  assertEquals(await readJsonCapped(post("{}", { "Content-Length": "-1" }), 1024), invalid);
});

Deno.test("a stream that fails mid-body is a 400, not a throw", async () => {
  const request = new Request(URL_, {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("client went away"));
      },
    }),
    // @ts-ignore: duplex is required for a streamed request body.
    duplex: "half",
  });
  assertEquals(await readJsonCapped(request, 1024), { ok: false, status: 400, code: "bad_request" });
});
