// Contract test: drive the real CanvasClient against recorded, real-shaped
// Canvas payloads (fixtures/canvas-api) via a stubbed fetch, then feed the
// enumeration through diffSources. Pins the client↔payload contract and the
// re-import diff behavior without a network or database.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { CanvasClient } from "../supabase/functions/_shared/canvas.ts";
import {
  diffSources,
  type EnumeratedSource,
  type ExistingSourceRow,
} from "../supabase/functions/_shared/enumerate.ts";
import { defaultState, routeCanvas, type MockCanvasState } from "./helpers/mock-canvas.ts";

const BASE = "https://canvas.school.edu";
const COURSE = "1549777";

let state: MockCanvasState;
const realFetch = globalThis.fetch;

beforeEach(() => {
  state = defaultState();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return Promise.resolve(new Response("unauthorized", { status: 401 }));
    }
    const routed = routeCanvas(url.pathname + url.search, BASE, state);
    if (!routed) return Promise.resolve(new Response("not found", { status: 404 }));
    return Promise.resolve(
      new Response(routed.body as BodyInit, {
        status: routed.status,
        headers: { "Content-Type": routed.contentType, ...routed.headers },
      }),
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function client(): CanvasClient {
  return new CanvasClient(BASE, "test-token");
}

test("listPdfFiles follows Link pagination and keeps only PDFs, with folder paths", async () => {
  const files = await client().listPdfFiles(COURSE);
  assert.deepEqual(files.map((f) => f.fileId).sort(), ["98765", "98767"]);
  const lecture = files.find((f) => f.fileId === "98765")!;
  assert.equal(lecture.title, "lecture-7-respiration");
  assert.equal(lecture.folderPath, "Lectures");
  assert.equal(lecture.moduleName, "Unit 3 — Cellular Respiration");
  assert.equal(lecture.updatedAt, "2026-07-01T12:00:00Z");
});

test("listPages drops unpublished pages; listAssignments carries due_at", async () => {
  const pages = await client().listPages(COURSE);
  assert.deepEqual(pages.map((p) => p.urlSlug), ["week-6-overview"]);

  const assignments = await client().listAssignments(COURSE);
  assert.equal(assignments.length, 2);
  assert.equal(assignments[0]!.dueAt, "2026-08-05T06:59:00Z");
  assert.equal(assignments[1]!.descriptionHtml, null);
});

test("listModuleItems recovers module-only pages and files", async () => {
  const items = await client().listModuleItems(COURSE);
  const pageSlugs = items.filter((i) => i.type === "Page").map((i) => i.pageUrl);
  assert.deepEqual(pageSlugs, ["week-6-overview", "module-only-page"]);
  const file = items.find((i) => i.type === "File");
  assert.equal(file?.fileId, "98765");
});

test("getCourseSyllabusText strips the syllabus HTML", async () => {
  const text = await client().getCourseSyllabusText(COURSE);
  assert.match(text ?? "", /Weekly labs are due Fridays/);
  assert.doesNotMatch(text ?? "", /<h2>/);
});

// ---------------------------------------------------------------------------
// Enumeration → diff: the full re-import decision path over real-shaped data.
// ---------------------------------------------------------------------------

async function enumerate(): Promise<EnumeratedSource[]> {
  const canvas = client();
  const [files, pages, assignments] = await Promise.all([
    canvas.listPdfFiles(COURSE),
    canvas.listPages(COURSE),
    canvas.listAssignments(COURSE),
  ]);
  const sources: EnumeratedSource[] = [];
  const common = { user_id: "u1", course_id: "c1", module_name: null, folder_path: null };
  for (const file of files) {
    sources.push({
      ...common,
      origin: "canvas_file",
      source_kind: "pdf",
      canvas_id: file.fileId,
      title: file.title,
      canvas_url: file.downloadUrl,
      content_role: "material",
      size_bytes: file.sizeBytes,
      canvas_updated_at: file.updatedAt,
      due_at: null,
      status: "queued",
    });
  }
  for (const page of pages) {
    sources.push({
      ...common,
      origin: "canvas_page",
      source_kind: "html",
      canvas_id: page.urlSlug,
      title: page.title,
      canvas_url: page.htmlUrl,
      content_role: "material",
      size_bytes: null,
      canvas_updated_at: page.updatedAt,
      due_at: null,
      status: "queued",
    });
  }
  for (const assignment of assignments) {
    if (!assignment.descriptionHtml) continue;
    sources.push({
      ...common,
      origin: "canvas_assignment",
      source_kind: "html",
      canvas_id: assignment.assignmentId,
      title: assignment.title,
      canvas_url: assignment.htmlUrl,
      content_role: "assignment",
      size_bytes: null,
      canvas_updated_at: assignment.updatedAt,
      due_at: assignment.dueAt,
      status: "queued",
    });
  }
  return sources;
}

function asExisting(sources: EnumeratedSource[]): ExistingSourceRow[] {
  return sources.map((source, i) => ({
    id: `row-${i}`,
    origin: source.origin,
    canvas_id: source.canvas_id,
    canvas_updated_at: source.canvas_updated_at,
    status: "ready",
    due_at: source.due_at,
    title: source.title,
    canvas_url: source.canvas_url,
  }));
}

test("fresh import queues everything; identical re-import queues nothing", async () => {
  const enumerated = await enumerate();
  assert.equal(enumerated.length, 4); // 2 PDFs + 1 page + 1 assignment with description

  const fresh = diffSources(enumerated, [], false);
  assert.equal(fresh.toInsert.length, 4);

  const again = diffSources(await enumerate(), asExisting(enumerated), false);
  assert.deepEqual(again, { toInsert: [], toRefresh: [], toPatch: [] });
});

test("a page edited on Canvas is the only thing re-queued on re-import", async () => {
  const existing = asExisting(await enumerate());

  state.pageUpdatedAt = "2026-07-20T10:00:00Z"; // page revised after first import
  const diff = diffSources(await enumerate(), existing, false);

  assert.equal(diff.toInsert.length, 0);
  assert.equal(diff.toRefresh.length, 1);
  const refreshed = existing.find((row) => row.canvas_id === "week-6-overview")!;
  assert.equal(diff.toRefresh[0]!.id, refreshed.id);
  assert.equal(diff.toRefresh[0]!.patch.needs_refresh, true);
  assert.equal(diff.toRefresh[0]!.patch.status, "queued");
});

test("a moved due date patches metadata without re-processing content", async () => {
  const enumerated = await enumerate();
  const existing = asExisting(enumerated).map((row) =>
    row.origin === "canvas_assignment" ? { ...row, due_at: "2026-08-01T06:59:00Z" } : row,
  );
  const diff = diffSources(enumerated, existing, false);
  assert.equal(diff.toRefresh.length, 0);
  assert.equal(diff.toPatch.length, 1);
  assert.equal(diff.toPatch[0]!.patch.due_at, "2026-08-05T06:59:00Z");
});
