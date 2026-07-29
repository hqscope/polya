import { test } from "node:test";
import assert from "node:assert/strict";

import {
  diffSources,
  type EnumeratedSource,
  type ExistingSourceRow,
} from "../supabase/functions/_shared/enumerate.ts";

function enumerated(overrides: Partial<EnumeratedSource> = {}): EnumeratedSource {
  return {
    user_id: "u1",
    course_id: "c1",
    origin: "canvas_page",
    source_kind: "html",
    canvas_id: "week-1",
    title: "Week 1",
    module_name: null,
    folder_path: null,
    canvas_url: "https://canvas.school.edu/pages/week-1",
    content_role: "material",
    size_bytes: null,
    canvas_updated_at: "2026-07-01T00:00:00Z",
    due_at: null,
    status: "queued",
    ...overrides,
  };
}

function existing(overrides: Partial<ExistingSourceRow> = {}): ExistingSourceRow {
  return {
    id: "row-1",
    origin: "canvas_page",
    canvas_id: "week-1",
    canvas_updated_at: "2026-07-01T00:00:00Z",
    status: "ready",
    due_at: null,
    title: "Week 1",
    canvas_url: "https://canvas.school.edu/pages/week-1",
    ...overrides,
  };
}

test("fresh import queues everything", () => {
  const diff = diffSources([enumerated(), enumerated({ canvas_id: "week-2" })], [], false);
  assert.equal(diff.toInsert.length, 2);
  assert.equal(diff.toRefresh.length, 0);
  assert.equal(diff.toPatch.length, 0);
});

test("unchanged re-import queues nothing", () => {
  const diff = diffSources([enumerated()], [existing()], false);
  assert.deepEqual(diff, { toInsert: [], toRefresh: [], toPatch: [] });
});

test("a newer canvas_updated_at re-queues the source with reset fields", () => {
  const diff = diffSources(
    [enumerated({ canvas_updated_at: "2026-07-10T00:00:00Z", title: "Week 1 (rev)" })],
    [existing()],
    false,
  );
  assert.equal(diff.toRefresh.length, 1);
  const patch = diff.toRefresh[0]!.patch;
  assert.equal(diff.toRefresh[0]!.id, "row-1");
  assert.equal(patch.needs_refresh, true);
  assert.equal(patch.status, "queued");
  assert.equal(patch.attempts, 0);
  assert.equal(patch.claimed_at, null);
  assert.equal(patch.title, "Week 1 (rev)");
  assert.equal(patch.canvas_updated_at, "2026-07-10T00:00:00Z");
});

test("a timestamp appearing where none was stored counts as newer", () => {
  const diff = diffSources([enumerated()], [existing({ canvas_updated_at: null })], false);
  assert.equal(diff.toRefresh.length, 1);
});

test("force re-queues sources with no timestamp at all (syllabus, module items)", () => {
  const noStamp = enumerated({ origin: "canvas_syllabus", canvas_id: "syllabus", canvas_updated_at: null });
  const stored = existing({ origin: "canvas_syllabus", canvas_id: "syllabus", canvas_updated_at: null });
  assert.equal(diffSources([noStamp], [stored], false).toRefresh.length, 0);
  assert.equal(diffSources([noStamp], [stored], true).toRefresh.length, 1);
});

test("a changed due date patches metadata without a refresh", () => {
  const diff = diffSources(
    [enumerated({ origin: "canvas_assignment", canvas_id: "a1", due_at: "2026-08-01T00:00:00Z" })],
    [existing({ origin: "canvas_assignment", canvas_id: "a1", due_at: null })],
    false,
  );
  assert.equal(diff.toRefresh.length, 0);
  assert.equal(diff.toPatch.length, 1);
  assert.deepEqual(diff.toPatch[0]!.patch, { due_at: "2026-08-01T00:00:00Z" });
});

test("in-flight sources are never yanked into a refresh", () => {
  const diff = diffSources(
    [enumerated({ canvas_updated_at: "2026-07-10T00:00:00Z" })],
    [existing({ status: "parsing" })],
    true,
  );
  assert.deepEqual(diff, { toInsert: [], toRefresh: [], toPatch: [] });
});

test("uploaded transcripts (canvas_id null) are untouched by enumeration", () => {
  const upload = existing({ id: "row-up", origin: "upload_transcript", canvas_id: null });
  const diff = diffSources([enumerated()], [upload, existing()], true);
  assert.equal(diff.toRefresh.length, 1);
  assert.equal(diff.toRefresh[0]!.id, "row-1");
});
