// The background pump and a PDF too big to store. polya_documents refuses
// anything over MAX_UPLOAD_BYTES, and downloading a 100 MB textbook used to run
// the isolate out of memory before the failure was recorded, so the same file
// was claimed again every cycle ahead of everything queued behind it. It must
// now fail before any download. Exercised through the real handler against a
// fake backend.
//
// Run: deno test --allow-env --allow-read --no-check supabase/functions/polya-import/
import { assert, assertEquals } from "jsr:@std/assert@1";
import { jsonResponse, loadHandler, rpcName, setBackend, TEST_PUMP_SECRET, TEST_USER_ID } from "../_shared/test-serve.ts";
import { MAX_UPLOAD_BYTES, UPLOAD_TOO_LARGE_MESSAGE } from "../_shared/upload-checks.ts";

const handler = await loadHandler(new URL("./index.ts", import.meta.url).href);
const URL_ = "http://polya.test/functions/v1/polya-import";

function source(sizeBytes: number) {
  return {
    id: "00000000-0000-4000-8000-0000000000f1",
    user_id: TEST_USER_ID,
    course_id: "00000000-0000-4000-8000-0000000000c1",
    origin: "site_file",
    source_kind: "pdf",
    canvas_id: null,
    title: "Genetics 6th Edition",
    module_name: null,
    canvas_url: "https://course.example/genetics.pdf",
    storage_path: null,
    content_sha256: null,
    size_bytes: sizeBytes,
    page_count: 0,
    pages_parsed: 0,
    chunks_embedded: 0,
    content_role: null,
    status: "queued",
    attempts: 0,
    needs_refresh: false,
  };
}

/** Runs one pump cycle over `claimed` and returns what it touched, once the source row is settled. */
async function pumpOnce(claimed: ReturnType<typeof source>, served = new Uint8Array(16)): Promise<string[]> {
  const log: string[] = [];
  let renewals = 0;
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => (settle = resolve));
  setBackend(async (url, request) => {
    const name = rpcName(url);
    // One cycle: the second renewal says the lease is gone, so the drain stops.
    if (name === "polya_renew_import_lease") return jsonResponse(++renewals === 1);
    if (name === "polya_claim_import_batch") return jsonResponse([claimed]);
    if (name) {
      log.push(`rpc ${name}`);
      return jsonResponse(null);
    }
    if (url.hostname === "course.example") {
      log.push("download");
      return new Response(served, { headers: { "Content-Type": "application/pdf" } });
    }
    if (url.pathname.startsWith("/storage/v1/object")) {
      log.push("upload");
      return jsonResponse({ Key: "stored" });
    }
    if (url.pathname === "/functions/v1/polya-import") {
      log.push("hand-off");
      settle();
      return jsonResponse({ ok: true }, 202);
    }
    if (url.pathname === "/rest/v1/polya_sources" && request.method === "PATCH") {
      const body = (await request.json()) as Record<string, unknown>;
      log.push(`PATCH ${JSON.stringify(body)}`);
      // advanceClaimedSource releases the lease last.
      if ("claimed_at" in body) settle();
      return new Response(null, { status: 204 });
    }
    return null;
  });
  const response = await handler(
    new Request(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-polya-pump-secret": TEST_PUMP_SECRET },
      body: JSON.stringify({ action: "pump", user_id: TEST_USER_ID, lease_token: "lease" }),
    }),
  );
  assertEquals(response.status, 200);
  await response.body?.cancel();
  await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  return log;
}

Deno.test("a PDF over the storage cap fails before it's downloaded", async () => {
  const log = await pumpOnce(source(106_799_839));
  assert(!log.includes("download"), "the oversized file is never fetched");
  const failed = log.find((line) => line.includes('"status":"failed"'));
  assert(failed, `the source is marked failed: ${log.join(" | ")}`);
  assert(failed.includes(UPLOAD_TOO_LARGE_MESSAGE));
});

Deno.test("a course-website PDF of unknown size fails after the download, before upload or parsing", async () => {
  const oversized = new Uint8Array(MAX_UPLOAD_BYTES + 1);
  oversized.set(new TextEncoder().encode("%PDF-1.7\n"));
  const log = await pumpOnce({ ...source(0), size_bytes: null as unknown as number }, oversized);
  assert(log.includes("download"), "its size is only known once fetched");
  assert(!log.includes("upload"), "nothing over the cap reaches storage");
  const failed = log.find((line) => line.includes('"status":"failed"'));
  assert(failed?.includes(UPLOAD_TOO_LARGE_MESSAGE), `the source is marked failed: ${log.join(" | ")}`);
});
