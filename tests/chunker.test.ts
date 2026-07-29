import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHUNK_MAX_CHARS,
  CHUNK_OVERLAP_CHARS,
  chunkPages,
  splitTextIntoChunks,
} from "../supabase/functions/_shared/chunker.ts";

test("short text yields a single chunk", () => {
  const chunks = splitTextIntoChunks("A short paragraph.");
  assert.deepEqual(chunks, ["A short paragraph."]);
});

test("empty / whitespace text yields no chunks", () => {
  assert.deepEqual(splitTextIntoChunks(""), []);
  assert.deepEqual(splitTextIntoChunks("   \n  "), []);
});

test("long text chunks stay within CHUNK_MAX_CHARS and cover the source", () => {
  const sentence = "The mitochondria convert glucose into usable energy for the cell. ";
  const source = sentence.repeat(200); // ~13k chars
  const chunks = splitTextIntoChunks(source);

  assert.ok(chunks.length > 1, "expected multiple chunks");
  for (const chunk of chunks) {
    assert.ok(
      chunk.length <= CHUNK_MAX_CHARS,
      `chunk exceeded max (${chunk.length} > ${CHUNK_MAX_CHARS})`,
    );
  }
  // Every chunk should end on the snapped sentence boundary (". ") except possibly the last.
  for (const chunk of chunks.slice(0, -1)) {
    assert.ok(chunk.endsWith("."), `expected sentence-boundary snap, got: …${chunk.slice(-20)}`);
  }
});

test("consecutive chunks overlap by ~CHUNK_OVERLAP_CHARS of source text", () => {
  // Boundary-free text (no newline / '. ' / '; ') exercises the raw window math.
  const source = "x".repeat(CHUNK_MAX_CHARS * 3);
  const chunks = splitTextIntoChunks(source);

  assert.equal(chunks[0]!.length, CHUNK_MAX_CHARS);
  // Window advances by MAX - OVERLAP when no boundary snap applies.
  const expectedChunks = Math.ceil(
    (source.length - CHUNK_MAX_CHARS) / (CHUNK_MAX_CHARS - CHUNK_OVERLAP_CHARS),
  ) + 1;
  assert.equal(chunks.length, expectedChunks);
});

test("boundary snap only engages past start+500", () => {
  // A newline very early (position 10) must NOT become the cut point.
  const source = `${"a".repeat(10)}\n${"b".repeat(CHUNK_MAX_CHARS * 2)}`;
  const chunks = splitTextIntoChunks(source);
  assert.ok(
    chunks[0]!.length > 500,
    `early boundary should be ignored (first chunk was ${chunks[0]!.length} chars)`,
  );
});

test("chunkPages keeps every chunk on its page and numbers pages correctly", () => {
  const longPage = "Cell respiration continues. ".repeat(120); // > CHUNK_MAX_CHARS
  const chunks = chunkPages(["First page text.", longPage]);

  assert.equal(chunks[0]!.pageStart, 1);
  assert.equal(chunks[0]!.pageEnd, 1);

  const pageTwo = chunks.filter((chunk) => chunk.pageStart === 2);
  assert.ok(pageTwo.length >= 2, "long page should split into multiple chunks");
  for (const chunk of pageTwo) {
    assert.equal(chunk.pageEnd, 2, "chunks never span pages");
  }
  pageTwo.forEach((chunk, idx) => assert.equal(chunk.ordinalOnPage, idx));
});
