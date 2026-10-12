import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LARGE_PDF_BYTES,
  splitPageMarkers,
  WHOLE_DOC_MAX_PAGES,
  wholeDocumentPrompt,
} from "../supabase/functions/_shared/ocr-pages.ts";

test("the prompt names the wanted pages, the total, and the marker format", () => {
  const prompt = wholeDocumentPrompt([3, 4, 5], 11);
  assert.match(prompt, /This PDF has 11 pages/);
  assert.match(prompt, /pages 3, 4, 5 \(1-indexed\) and no other pages/);
  assert.match(prompt, /"=== PAGE n ==="/);
  assert.match(wholeDocumentPrompt([7], 7), /page 7 \(1-indexed\)/);
});

test("markers split into per-page text, in the order asked for", () => {
  const out = splitPageMarkers(
    "preamble the model shouldn't write\n=== PAGE 1 ===\nFirst page.\nSecond line.  \n\n=== PAGE 2 ===\n\nCanto II\n",
    [1, 2],
    1,
  );
  assert.deepEqual(out, [
    { pageNum: 1, text: "First page.\nSecond line." },
    { pageNum: 2, text: "Canto II" },
  ]);
});

test("pages that weren't asked for, repeats, and blank pages are dropped", () => {
  const out = splitPageMarkers(
    "=== PAGE 2 ===\nnot wanted\n=== PAGE 3 ===\n   \n=== PAGE 4 ===\nreal text here\n=== PAGE 4 ===\nduplicate\n",
    [3, 4, 5],
    12,
  );
  assert.deepEqual(out, [{ pageNum: 4, text: "real text here" }]);
});

test("a truncated transcription keeps the pages that completed", () => {
  const out = splitPageMarkers("=== PAGE 9 ===\nComplete page.\n=== PAGE 10 ===\nCut off mid", [9, 10], 1);
  assert.equal(out.length, 2);
  assert.equal(out[1]!.text, "Cut off mid");
});

test("limits match the edge runtime and the PDF API", () => {
  assert.ok(LARGE_PDF_BYTES <= 8 * 1024 * 1024, "slicing a bigger file than this blows the 2 s CPU budget");
  assert.equal(WHOLE_DOC_MAX_PAGES, 100, "the Messages API caps a PDF at 100 pages");
});
