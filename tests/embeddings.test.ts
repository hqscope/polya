import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMBED_DIM,
  fallbackEmbedding,
  l2Normalize,
  toVectorLiteral,
} from "../supabase/functions/_shared/embeddings.ts";

function norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

test("l2Normalize returns a unit vector", () => {
  const out = l2Normalize([3, 4]);
  assert.ok(Math.abs(norm(out) - 1) < 1e-9);
  assert.ok(Math.abs(out[0]! - 0.6) < 1e-9);
});

test("l2Normalize leaves a zero vector unchanged (no NaN)", () => {
  const out = l2Normalize([0, 0, 0]);
  assert.deepEqual(out, [0, 0, 0]);
});

test("fallbackEmbedding is 1536-dim and unit-norm", () => {
  const vector = fallbackEmbedding("the electron transport chain requires oxygen");
  assert.equal(vector.length, EMBED_DIM);
  assert.ok(Math.abs(norm(vector) - 1) < 1e-9);
});

test("fallbackEmbedding is deterministic and content-sensitive", () => {
  const a1 = fallbackEmbedding("oxygen is the terminal electron acceptor");
  const a2 = fallbackEmbedding("oxygen is the terminal electron acceptor");
  const b = fallbackEmbedding("the mitochondrion has a double membrane");
  assert.deepEqual(a1, a2);
  const dotAB = a1.reduce((sum, value, i) => sum + value * b[i]!, 0);
  assert.ok(dotAB < 0.99, "different text should not be near-identical");
});

test("toVectorLiteral produces a pgvector literal", () => {
  assert.equal(toVectorLiteral([0.1, 0.2, 0.3]), "[0.1,0.2,0.3]");
});
