import { test } from "node:test";
import assert from "node:assert/strict";

import { rrfMerge } from "../supabase/functions/_shared/rrf.ts";

interface Hit {
  id: string;
}

const byId = (hit: Hit) => hit.id;

test("item ranked in both lists outranks single-list items", () => {
  const semantic: Hit[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const lexical: Hit[] = [{ id: "c" }, { id: "d" }];

  const merged = rrfMerge(semantic, lexical, byId);
  // c: 1/(60+3) + 1/(60+1) > a: 1/(60+1)
  assert.equal(merged[0]!.id, "c");
  assert.deepEqual(
    merged.map((hit) => hit.id).sort(),
    ["a", "b", "c", "d"],
  );
});

test("k=60 scoring matches the reference formula", () => {
  const merged = rrfMerge<Hit>([{ id: "x" }], [{ id: "y" }], byId);
  // Both score 1/61 — first-processed list wins ties via Map insertion order.
  assert.equal(merged.length, 2);
  assert.equal(merged[0]!.id, "x");
});

test("empty inputs are safe", () => {
  assert.deepEqual(rrfMerge<Hit>([], [], byId), []);
  const oneSided = rrfMerge<Hit>([{ id: "only" }], [], byId);
  assert.equal(oneSided[0]!.id, "only");
});

test("weightOf lets a lower-ranked but heavier item overtake", () => {
  interface RoleHit {
    id: string;
    role: "material" | "assignment";
  }
  const semantic: RoleHit[] = [
    { id: "assignment-top", role: "assignment" },
    { id: "material-second", role: "material" },
  ];
  const weightOf = (hit: RoleHit) => (hit.role === "material" ? 1.0 : 0.5);

  // Without weights the rank-1 assignment wins; with a heavy enough penalty the
  // rank-2 material item overtakes it.
  const unweighted = rrfMerge<RoleHit>(semantic, [], (h) => h.id);
  assert.equal(unweighted[0]!.id, "assignment-top");

  const weighted = rrfMerge<RoleHit>(semantic, [], (h) => h.id, 60, weightOf);
  // assignment: 0.5/61 ≈ 0.0082 ; material: 1.0/62 ≈ 0.0161 → material wins
  assert.equal(weighted[0]!.id, "material-second");
});
