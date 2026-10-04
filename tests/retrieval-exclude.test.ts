import { test } from "node:test";
import assert from "node:assert/strict";

import { retrieve } from "../supabase/functions/_shared/retrieval.ts";
import type { RetrievedUnit } from "../supabase/functions/_shared/retrieval-types.ts";

function unit(overrides: Partial<RetrievedUnit>): RetrievedUnit {
  return {
    unit_id: "u",
    source_id: "s1",
    title: "Lecture 3",
    unit_type: "chunk",
    content_role: "material",
    ordinal: 1,
    heading_path: null,
    page_start: null,
    page_end: null,
    t_start_ms: null,
    t_end_ms: null,
    procedure_id: null,
    step_number: null,
    content: "Bayes' rule relates conditional probabilities.",
    score: 0.9,
    ...overrides,
  };
}

// A material hit whose ordinal neighbor and procedure sibling are solution keys.
// The RPCs already filter hits by role; the expansion reads the table directly.
function fakeClient(expansionRows: RetrievedUnit[]) {
  const hit = unit({ unit_id: "hit", ordinal: 1, procedure_id: "p1" });
  const query = {
    select: () => query,
    eq: () => query,
    or: () => Promise.resolve({ data: expansionRows }),
    in: () => Promise.resolve({ data: expansionRows }),
  };
  const client = {
    rpc: () => Promise.resolve({ data: [hit] }),
    from: () => query,
  };
  // Minimal structural fake: only the calls retrieve() makes.
  return client as unknown as Parameters<typeof retrieve>[0];
}

test("practice mode: expansion never adds excluded roles", async () => {
  const rows = [
    unit({ unit_id: "neighbor-key", ordinal: 2, content_role: "solution_key", score: 0 }),
    unit({ unit_id: "sibling-key", ordinal: 3, procedure_id: "p1", content_role: "solution_key", score: 0 }),
    unit({ unit_id: "neighbor-ok", ordinal: 0, score: 0 }),
  ];
  const units = await retrieve(fakeClient(rows), "c1", "bayes rule", ["solution_key"]);
  const ids = units.map((u) => u.unit_id);
  assert.ok(ids.includes("hit"));
  assert.ok(ids.includes("neighbor-ok"));
  assert.ok(!ids.includes("neighbor-key"));
  assert.ok(!ids.includes("sibling-key"));
});

test("other modes: expansion keeps every role", async () => {
  const rows = [unit({ unit_id: "neighbor-key", ordinal: 2, content_role: "solution_key", score: 0 })];
  const units = await retrieve(fakeClient(rows), "c1", "bayes rule");
  assert.ok(units.map((u) => u.unit_id).includes("neighbor-key"));
});
