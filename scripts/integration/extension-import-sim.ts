// Emulates the Canvascope extension's Polya import against a Polya backend:
// upload content to storage with the user JWT, call extension_import_start /
// extension_register_source, pump processing, print the outcome. Lets the
// Polya side of the zero-pairing flow be QA'd without loading the extension.
//
// Env: same as run-import-integration.ts (POLYA_SUPABASE_URL, POLYA_ANON_KEY,
// POLYA_TEST_EMAIL, POLYA_TEST_PASSWORD).
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const demoCourseRoot = join(here, "..", "..", "fixtures", "demo-course");

const SUPABASE_URL = process.env.POLYA_SUPABASE_URL ?? "http://127.0.0.1:54331";
const ANON_KEY = process.env.POLYA_ANON_KEY ?? "";
const FUNCTIONS_URL = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1`;

async function signIn(): Promise<{ token: string; userId: string }> {
  const email = process.env.POLYA_TEST_EMAIL ?? "polya-integration@example.com";
  const password = process.env.POLYA_TEST_PASSWORD ?? "polya-integration-pw-1";
  for (const path of ["/auth/v1/token?grant_type=password", "/auth/v1/signup"]) {
    const resp = await fetch(`${SUPABASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.access_token) {
      return { token: data.access_token as string, userId: data.user.id as string };
    }
  }
  throw new Error("Couldn't obtain a user access token.");
}

async function invoke<T>(token: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${FUNCTIONS_URL}/polya-import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`polya-import ${resp.status}: ${JSON.stringify(data)}`);
  return data as T;
}

// The exact storage upload the extension performs: REST PUT with the user JWT,
// path under the user's own prefix (allowed by polya_documents_insert_own).
async function uploadToBucket(
  token: string,
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/polya_documents/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: ANON_KEY,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: bytes as unknown as BodyInit,
  });
  if (!resp.ok) throw new Error(`storage upload ${path} → ${resp.status} ${await resp.text()}`);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  if (!ANON_KEY) throw new Error("Set POLYA_ANON_KEY.");
  const { token, userId } = await signIn();

  const pdfBytes = new Uint8Array(
    await readFile(join(demoCourseRoot, "pdfs", "lecture-7-respiration.pdf")),
  );
  const pageHtml = new TextEncoder().encode(
    "<h2>Week 6 Overview</h2><p>Sent from the extension simulator: glycolysis, Krebs cycle, electron transport chain — where each stage happens and what it produces.</p>",
  );

  const manifest = [
    {
      origin: "canvas_file",
      source_kind: "pdf",
      canvas_id: "98765",
      title: "lecture-7-respiration",
      module_name: "Unit 3 — Cellular Respiration",
      canvas_url: "https://canvas.school.edu/files/98765/download?download_frd=1",
      size_bytes: pdfBytes.byteLength,
      canvas_updated_at: "2026-07-01T12:00:00Z",
      content_sha256: sha256Hex(pdfBytes),
    },
    {
      origin: "canvas_page",
      source_kind: "html",
      canvas_id: "week-6-overview",
      title: "Week 6 Overview",
      canvas_url: "https://canvas.school.edu/courses/1549777/pages/week-6-overview",
      canvas_updated_at: "2026-07-03T08:00:00Z",
      content_sha256: sha256Hex(pageHtml),
    },
  ];

  console.log("extension_import_start…");
  const started = await invoke<{
    course_id: string;
    needed: Array<{ origin: string; canvas_id: string; reason: string }>;
    unchanged: number;
  }>(token, {
    action: "extension_import_start",
    canvas: {
      base_url: "https://canvas.school.edu",
      course_id: "1549777",
      name: "Demo Biology 1AL (extension)",
      code: "BIO 1AL",
    },
    manifest,
  });
  console.log(`  course_id=${started.course_id} needed=${JSON.stringify(started.needed)} unchanged=${started.unchanged}`);

  const bytesByKey: Record<string, { bytes: Uint8Array; contentType: string; ext: string }> = {
    "canvas_file:98765": { bytes: pdfBytes, contentType: "application/pdf", ext: "pdf" },
    "canvas_page:week-6-overview": { bytes: pageHtml, contentType: "text/html", ext: "html" },
  };

  for (const item of started.needed) {
    const payload = bytesByKey[`${item.origin}:${item.canvas_id}`];
    if (!payload) continue;
    const storagePath = `${userId}/uploads/${randomUUID()}.${payload.ext}`;
    await uploadToBucket(token, storagePath, payload.bytes, payload.contentType);
    const entry = manifest.find(
      (m) => m.origin === item.origin && m.canvas_id === item.canvas_id,
    )!;
    const registered = await invoke<{ source_id: string }>(token, {
      action: "extension_register_source",
      course_id: started.course_id,
      source: { ...entry, storage_path: storagePath },
    });
    console.log(`  registered ${item.origin}:${item.canvas_id} → ${registered.source_id}`);
  }

  console.log("pumping…");
  let steps = 0;
  while (steps++ < 300) {
    const result = await invoke<{ done: boolean; retry_after_ms?: number }>(token, {
      action: "process",
      course_id: started.course_id,
    });
    if (result.done) break;
    if (result.retry_after_ms) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(result.retry_after_ms, 5000)));
    }
  }

  const status = await invoke<{
    progress: Record<string, number>;
    sources: Array<{ title: string; status: string; chunks_embedded: number }>;
  }>(token, { action: "status", course_id: started.course_id });
  console.log("Final:", JSON.stringify(status.progress));
  for (const source of status.sources) {
    console.log(`  - ${source.title}: ${source.status} (${source.chunks_embedded} units)`);
  }

  console.log("\nRe-running extension_import_start (everything should be unchanged)…");
  const rerun = await invoke<{ needed: unknown[]; unchanged: number }>(token, {
    action: "extension_import_start",
    canvas: {
      base_url: "https://canvas.school.edu",
      course_id: "1549777",
      name: "Demo Biology 1AL (extension)",
    },
    manifest,
  });
  console.log(`  needed=${JSON.stringify(rerun.needed)} unchanged=${rerun.unchanged}`);
  console.log(`\nCOURSE_ID=${started.course_id}`);
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
