import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contentSignature,
  dedupeBySignature,
  roleWeight,
} from "../supabase/functions/_shared/rank.ts";

test("roleWeight favors material over assignment/syllabus, defaults to 1", () => {
  assert.equal(roleWeight("material"), 1.0);
  assert.ok(roleWeight("assignment") < roleWeight("material"));
  assert.ok(roleWeight("syllabus") < roleWeight("material"));
  assert.equal(roleWeight("something_unknown"), 1.0);
});

test("contentSignature normalizes case/whitespace/punctuation to first 160 chars", () => {
  assert.equal(
    contentSignature("Complete and submit THIS quiz!!!  before the due date."),
    "complete and submit this quiz before the due date",
  );
});

test("dedupeBySignature collapses near-identical boilerplate, keeps order", () => {
  const boiler =
    "Complete and submit this post-lab assessment quiz before the due date for full credit.";
  const hits = [
    { unit_id: "a", content: `${boiler} There is no time limit.` },
    { unit_id: "b", content: `${boiler} There is no time limit.` }, // identical prefix → dropped
    { unit_id: "c", content: "Vmax is the maximum rate of an enzyme-catalyzed reaction at saturation." },
  ];
  assert.deepEqual(
    dedupeBySignature(hits).map((h) => h.unit_id),
    ["a", "c"],
  );
});

test("dedupeBySignature keeps distinct content", () => {
  const hits = [
    { unit_id: "a", content: "Photosynthesis converts light to chemical energy." },
    { unit_id: "b", content: "Cellular respiration releases energy from glucose." },
  ];
  assert.equal(dedupeBySignature(hits).length, 2);
});
