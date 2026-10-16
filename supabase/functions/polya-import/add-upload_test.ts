// polya-import `add_upload`: the browser picks the kind, path and title of a
// file it already put in storage, so each is checked before anything is
// registered. Exercised through the real handler against a fake backend.
//
// Run: deno test --allow-env --allow-read --no-check supabase/functions/polya-import/
import { assertEquals } from "jsr:@std/assert@1";
import {
  authRoute,
  jsonResponse,
  loadHandler,
  rpcName,
  setBackend,
  TEST_USER_ID,
  TEST_USER_JWT,
} from "../_shared/test-serve.ts";

const handler = await loadHandler(new URL("./index.ts", import.meta.url).href);
const URL_ = "http://polya.test/functions/v1/polya-import";
const COURSE_ID = "00000000-0000-4000-8000-0000000000c1";
const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e";

// Allows the rate limiter, owns the course, lists one stored object of
// `storedSize` bytes, and records every table and storage call.
function backend(storedSize: number | null): string[] {
  const calls: string[] = [];
  setBackend((url, request) => {
    const auth = authRoute(url, request);
    if (auth) return auth;
    const name = rpcName(url);
    if (name) return jsonResponse(true);
    if (url.pathname === "/rest/v1/polya_courses") {
      calls.push("select polya_courses");
      return jsonResponse([{ id: COURSE_ID }]);
    }
    if (url.pathname.startsWith("/storage/v1/object/list/")) {
      calls.push("list storage");
      return jsonResponse(storedSize === null ? [] : [{ name: `${FILE}.pdf`, metadata: { size: storedSize } }]);
    }
    // The background pump kick after a successful registration.
    if (url.pathname === "/functions/v1/polya-import") return jsonResponse({ ok: true }, 202);
    if (url.pathname === "/rest/v1/polya_sources") {
      calls.push(`${request.method} polya_sources`);
      return jsonResponse({ id: "source-1" }, 201);
    }
    return null;
  });
  return calls;
}

function addUpload(body: Record<string, unknown>): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_USER_JWT}` },
    body: JSON.stringify({
      action: "add_upload",
      course_id: COURSE_ID,
      storage_path: `${TEST_USER_ID}/uploads/${FILE}.pdf`,
      title: "Pitman ch 3",
      kind: "pdf",
      ...body,
    }),
  });
}

Deno.test("an unknown kind is refused before anything is looked up", async () => {
  for (const kind of ["html", "exe", "", 7]) {
    const calls = backend(1000);
    const response = await handler(addUpload({ kind }));
    assertEquals(response.status, 400, String(kind));
    assertEquals((await response.json()).code, "bad_request");
    assertEquals(calls, [], "no table or storage access");
  }
});

Deno.test("a path outside the student's own uploads folder is refused", async () => {
  const paths = [
    `someone-else/uploads/${FILE}.pdf`,
    `${TEST_USER_ID}/elsewhere/${FILE}.pdf`,
    `${TEST_USER_ID}/uploads/${FILE}.txt`,
  ];
  for (const storage_path of paths) {
    const calls = backend(1000);
    const response = await handler(addUpload({ storage_path }));
    assertEquals(response.status, 400, storage_path);
    await response.body?.cancel();
    assertEquals(calls.includes("POST polya_sources"), false, "nothing registered");
  }
});

Deno.test("a missing or oversized stored file is refused; a good one is registered", async () => {
  let calls = backend(null);
  let response = await handler(addUpload({}));
  assertEquals(response.status, 400);
  await response.body?.cancel();
  assertEquals(calls.includes("POST polya_sources"), false);

  calls = backend(31 * 1024 * 1024);
  response = await handler(addUpload({}));
  assertEquals(response.status, 413);
  assertEquals((await response.json()).code, "too_large");
  assertEquals(calls.includes("POST polya_sources"), false);

  calls = backend(2 * 1024 * 1024);
  response = await handler(addUpload({}));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).source_id, "source-1");
  assertEquals(calls, ["select polya_courses", "list storage", "POST polya_sources"]);
});
