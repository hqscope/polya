// NUL bytes and lone surrogates in extracted text: Postgres rejects them, so
// one bad glyph used to fail a whole source's content_units insert.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ocrTextFromParts,
  pageTextFromItems,
  sanitizeDbText,
} from "../supabase/functions/_shared/db-text.ts";
import { chunkPages, splitTextIntoChunks } from "../supabase/functions/_shared/chunker.ts";
import { parseTranscript } from "../supabase/functions/_shared/transcripts.ts";

const NUL = "\u0000";
// What PostgREST would choke on: a NUL, or a surrogate that isn't half of a pair.
function isDbSafe(text: string): boolean {
  return !text.includes(NUL) && text.isWellFormed();
}

test("sanitizeDbText strips NULs and repairs lone surrogates, keeps real pairs", () => {
  assert.equal(sanitizeDbText(`Mich${NUL}aelis${NUL}${NUL}-Menten`), "Michaelis-Menten");
  assert.equal(sanitizeDbText("a\uD800b"), "a�b");
  assert.equal(sanitizeDbText("a\uDC00b"), "a�b");
  assert.equal(sanitizeDbText("emoji 😀 stays"), "emoji 😀 stays");
  assert.equal(sanitizeDbText("tab\tand\nnewline"), "tab\tand\nnewline");
  assert.equal(sanitizeDbText(undefined as unknown as string), "");
});

test("a pdf.js page made only of NUL glyphs collapses to empty (routes to OCR)", () => {
  // Unmapped CID-font glyphs come back as NULs; 60 of them used to pass the
  // 50-char text-page threshold and then fail the insert.
  const items = Array.from({ length: 60 }, () => ({ str: NUL }));
  assert.equal(pageTextFromItems(items), "");
});

test("pdf.js items: NULs removed before whitespace collapse, odd items tolerated", () => {
  const items = [{ str: "Enzyme" }, { str: NUL }, { str: "kinetics" }, {}, null, { str: " Vmax " }];
  assert.equal(pageTextFromItems(items), "Enzyme kinetics Vmax");
});

test("OCR parts are joined, sanitized, and trimmed", () => {
  const text = ocrTextFromParts([{ text: `H2O${NUL} + ATP  \n` }, {}, { text: "\uD83Dend" }]);
  assert.equal(text, "H2O + ATP\n�end");
  assert.ok(isDbSafe(text));
});

test("every chunk is DB-safe even when a caller hands raw text to the chunker", () => {
  const dirty = `Intro${NUL}. `.repeat(400) + "tail\uD800";
  const chunks = splitTextIntoChunks(dirty);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(isDbSafe(chunk));

  const pageChunks = chunkPages([{ pageNum: 3, text: `Page${NUL} three` }]);
  assert.deepEqual(pageChunks, [{ pageStart: 3, pageEnd: 3, ordinalOnPage: 0, text: "Page three" }]);
  assert.deepEqual(splitTextIntoChunks(NUL.repeat(10)), []);
});

test("transcripts: escaped NULs in Kaltura JSON are removed after parsing", () => {
  // JSON carries the NUL as an escape, so it only appears after JSON.parse.
  const raw = JSON.stringify([{ text: `Today${NUL} we cover glycolysis.`, startTime: 0, endTime: 4 }]);
  assert.ok(raw.includes("\\u0000"));
  const segments = parseTranscript(raw, "transcript_json");
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.text, "Today we cover glycolysis.");
});

test("transcripts: NUL-only segments are dropped and ordinals stay contiguous", () => {
  const raw = [
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:50.000",
    "First part of the lecture.",
    "",
    "00:00:50.000 --> 00:02:10.000",
    NUL.repeat(5),
    "",
    "00:02:10.000 --> 00:03:30.000",
    "Third part of the lecture.",
    "",
  ].join("\n");
  const segments = parseTranscript(raw, "transcript_vtt");
  assert.ok(segments.length >= 1);
  segments.forEach((segment, i) => {
    assert.equal(segment.ordinal, i);
    assert.ok(segment.text.length > 0);
    assert.ok(isDbSafe(segment.text));
  });

  const plain = parseTranscript(`${NUL}${NUL}\n\n${NUL}`, "transcript_txt");
  assert.deepEqual(plain, []);
});
