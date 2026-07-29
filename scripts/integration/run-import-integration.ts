// End-to-end import integration against the LOCAL supabase stack with a mock
// Canvas server — the test that would have caught the ON-CONFLICT arbiter bug.
//
// Flow: connect (mock Canvas on 127.0.0.1) → start → pump to done → assert
// statuses/units/due dates → edit a page on the mock server → re-import →
// assert only that page rebuilt → cross-user add_upload is rejected.
//
// Prereqs (documented, not automated):
//   1. supabase start
//   2. supabase/functions/.env contains POLYA_ALLOW_INSECURE_CANVAS=1,
//      POLYA_TOKEN_KEY=<openssl rand -base64 32>, GEMINI_API_KEY=<key>
//   3. supabase functions serve --env-file supabase/functions/.env
//   4. npm run test:integration
//
// Env (same conventions as seed-fixture):
//   POLYA_SUPABASE_URL   default http://127.0.0.1:54331
//   POLYA_ANON_KEY       anon key for the local stack
//   POLYA_TEST_EMAIL / POLYA_TEST_PASSWORD    primary test user
//   POLYA_TEST_EMAIL_2 / POLYA_TEST_PASSWORD_2 second user (authz check);
//     defaults derive from the primary email.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultState, routeCanvas } from "../../tests/helpers/mock-canvas.ts";

const here = dirname(fileURLToPath(import.meta.url));
const demoCourseRoot = join(here, "..", "..", "fixtures", "demo-course");

const SUPABASE_URL = process.env.POLYA_SUPABASE_URL ?? "http://127.0.0.1:54331";
const ANON_KEY = process.env.POLYA_ANON_KEY ?? "";
const FUNCTIONS_URL = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1`;
const REST_URL = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`;
const MOCK_PORT = Number(process.env.POLYA_MOCK_CANVAS_PORT ?? 8971);
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const MOCK_TOKEN = "mock-canvas-token";
const COURSE = "1549777";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function signIn(email: string, password: string): Promise<string> {
  for (const path of ["/auth/v1/token?grant_type=password", "/auth/v1/signup"]) {
    const resp = await fetch(`${SUPABASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.access_token) return data.access_token as string;
  }
  throw new Error(`Couldn't sign in/up ${email} on the local stack.`);
}

async function invoke<T>(
  token: string,
  name: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: T }> {
  const resp = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = (await resp.json().catch(() => ({}))) as T;
  return { status: resp.status, data };
}

async function restSelect<T>(token: string, pathAndQuery: string): Promise<T[]> {
  const resp = await fetch(`${REST_URL}/${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY },
  });
  if (!resp.ok) throw new Error(`REST ${pathAndQuery} → ${resp.status}`);
  return (await resp.json()) as T[];
}

async function pump(token: string, courseId: string): Promise<void> {
  let steps = 0;
  while (steps++ < 500) {
    const { data } = await invoke<{ done: boolean; retry_after_ms?: number }>(
      token,
      "polya-import",
      { action: "process", course_id: courseId },
    );
    if (data.done) return;
    if (data.retry_after_ms) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(data.retry_after_ms, 5000)));
    }
  }
  throw new Error("pump did not finish within 500 steps");
}

interface SourceRow {
  id: string;
  origin: string;
  canvas_id: string | null;
  title: string;
  status: string;
  due_at: string | null;
  chunks_embedded: number;
}

async function main() {
  if (!ANON_KEY) throw new Error("Set POLYA_ANON_KEY (local stack anon key).");
  const email = process.env.POLYA_TEST_EMAIL ?? "polya-integration@example.com";
  const password = process.env.POLYA_TEST_PASSWORD ?? "polya-integration-pw-1";
  const email2 = process.env.POLYA_TEST_EMAIL_2 ?? `second-${email}`;
  const password2 = process.env.POLYA_TEST_PASSWORD_2 ?? password;

  // Mock Canvas server (state is mutated between phases).
  const state = defaultState();
  state.pdfBytes = new Uint8Array(
    await readFile(join(demoCourseRoot, "pdfs", "choosing-a-test-method.pdf")),
  );
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${MOCK_TOKEN}`) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    const routed = routeCanvas(req.url ?? "/", MOCK_BASE, state);
    if (!routed) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(routed.status, { "Content-Type": routed.contentType, ...routed.headers });
    res.end(routed.body);
  });
  await new Promise<void>((resolve) => server.listen(MOCK_PORT, "127.0.0.1", resolve));
  console.log(`Mock Canvas listening at ${MOCK_BASE}`);

  try {
    const token = await signIn(email, password);

    console.log("\nPhase 1 — connect + import");
    const connect = await invoke<{ connection_id?: string; error?: string }>(token, "polya-canvas", {
      action: "connect",
      base_url: MOCK_BASE,
      access_token: MOCK_TOKEN,
    });
    check("connect accepts the local mock (POLYA_ALLOW_INSECURE_CANVAS)", connect.status === 200, JSON.stringify(connect.data));

    const started = await invoke<{ course_id: string; queued: number; refreshed: number }>(
      token,
      "polya-import",
      { action: "start", canvas_course_id: COURSE },
    );
    check("start enumerates the course", started.status === 200 && started.data.queued > 0, JSON.stringify(started.data));
    const courseId = started.data.course_id;

    await pump(token, courseId);
    const sources = await restSelect<SourceRow>(
      token,
      `polya_sources?course_id=eq.${courseId}&select=id,origin,canvas_id,title,status,due_at,chunks_embedded`,
    );
    const byStatus = sources.reduce<Record<string, number>>((acc, s) => {
      acc[s.status] = (acc[s.status] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`  sources: ${JSON.stringify(byStatus)}`);
    check("no source failed", !sources.some((s) => s.status === "failed"), JSON.stringify(sources.filter((s) => s.status === "failed")));
    const assignment = sources.find((s) => s.origin === "canvas_assignment");
    check("assignment due date persisted", assignment?.due_at === "2026-08-05T06:59:00+00:00" || assignment?.due_at === "2026-08-05T06:59:00Z", String(assignment?.due_at));
    const page = sources.find((s) => s.canvas_id === "week-6-overview");
    check("canvas page ingested", page?.status === "ready", String(page?.status));

    const procedures = await restSelect<{ id: string }>(
      token,
      `polya_procedures?course_id=eq.${courseId}&select=id`,
    );
    check("procedures extracted from the numbered-method PDF", procedures.length > 0);

    console.log("\nPhase 2 — unchanged re-import");
    const rerun = await invoke<{ queued: number; refreshed: number }>(token, "polya-import", {
      action: "start",
      canvas_course_id: COURSE,
    });
    check("nothing queued or refreshed", rerun.data.queued === 0 && rerun.data.refreshed === 0, JSON.stringify(rerun.data));

    console.log("\nPhase 3 — page edited on Canvas, re-import refreshes only it");
    const pdfUnitsBefore = await restSelect<{ id: string }>(
      token,
      `polya_content_units?source_id=eq.${sources.find((s) => s.origin === "canvas_file")!.id}&select=id&order=id`,
    );
    const pageUnitsBefore = await restSelect<{ id: string; content: string }>(
      token,
      `polya_content_units?source_id=eq.${page!.id}&select=id,content`,
    );

    state.pageBody =
      "<h2>Week 6 — REVISED</h2><p>Updated schedule: the electron transport chain lecture moves to Thursday, and fermentation is now covered in the Friday lab prep reading.</p>";
    state.pageUpdatedAt = "2026-07-21T09:00:00Z";

    const refresh = await invoke<{ queued: number; refreshed: number }>(token, "polya-import", {
      action: "start",
      canvas_course_id: COURSE,
    });
    check("exactly one source refreshed", refresh.data.refreshed === 1 && refresh.data.queued === 0, JSON.stringify(refresh.data));
    await pump(token, courseId);

    const pageUnitsAfter = await restSelect<{ id: string; content: string }>(
      token,
      `polya_content_units?source_id=eq.${page!.id}&select=id,content`,
    );
    check(
      "page units rebuilt with new content",
      pageUnitsAfter.length > 0 && pageUnitsAfter.some((u) => u.content.includes("REVISED")),
    );
    check(
      "old page units gone",
      !pageUnitsAfter.some((u) => pageUnitsBefore.map((b) => b.id).includes(u.id)),
    );
    const pdfUnitsAfter = await restSelect<{ id: string }>(
      token,
      `polya_content_units?source_id=eq.${sources.find((s) => s.origin === "canvas_file")!.id}&select=id&order=id`,
    );
    check(
      "unchanged PDF units untouched (same unit ids)",
      JSON.stringify(pdfUnitsAfter) === JSON.stringify(pdfUnitsBefore),
    );

    console.log("\nPhase 4 — cross-user add_upload is rejected");
    const token2 = await signIn(email2, password2);
    const stolen = await invoke<{ error?: string }>(token2, "polya-import", {
      action: "add_upload",
      course_id: courseId,
      storage_path: `${courseId}/nope.txt`,
      title: "not yours",
      kind: "transcript_txt",
    });
    check("second user gets 404 for someone else's course", stolen.status === 404, `status=${stolen.status}`);

    console.log(failures === 0 ? "\nAll integration checks passed." : `\n${failures} check(s) FAILED.`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
