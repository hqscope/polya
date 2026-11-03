import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addFigures,
  FIGURE_ONLY_PROMPT,
  figureLines,
  LARGE_PDF_BYTES,
  splitPageMarkers,
  WHOLE_DOC_MAX_PAGES,
  wholeDocumentPrompt,
} from "../supabase/functions/_shared/ocr-pages.ts";

test("the prompt names the wanted pages, the total, and the marker format", () => {
  const prompt = wholeDocumentPrompt([3, 4, 5], 11);
  assert.match(prompt, /This PDF has 11 pages/);
  assert.match(prompt, /pages 3, 4, 5 \(1-indexed\)/);
  assert.match(prompt, /Cover no other pages/);
  assert.match(prompt, /"Figure:"/);
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
  assert.equal(WHOLE_DOC_MAX_PAGES, 600, "the Messages API caps a PDF at 600 pages on a 1M-context model");
});

test("slide-like pages ask for pictures only, alongside or instead of full pages", () => {
  const both = wholeDocumentPrompt([2], 40, [5, 6]);
  assert.match(both, /Transcribe ALL readable text from page 2 \(1-indexed\)/);
  assert.match(both, /The text on pages 5, 6 has already been read/);
  const figuresOnly = wholeDocumentPrompt([], 40, [9]);
  assert.doesNotMatch(figuresOnly, /Transcribe ALL/);
  assert.match(figuresOnly, /The text on page 9 has already been read: for that page/);
  assert.match(FIGURE_ONLY_PROMPT, /If the page has no pictures, output nothing/);
});

test("picture lines are kept, everything else and empty ones dropped", () => {
  assert.equal(
    figureLines("Some text the model shouldn't repeat\n  Figure: a pH curve from 2 to 12, equivalence point at 8.3\nFigure:\nFigure: an arrow-pushing mechanism for an SN2 reaction"),
    "Figure: a pH curve from 2 to 12, equivalence point at 8.3\nFigure: an arrow-pushing mechanism for an SN2 reaction",
  );
  assert.equal(figureLines(""), "");
});

test("picture lines go under their own page's text", () => {
  const pages = [
    { pageNum: 3, text: "Glycolysis overview" },
    { pageNum: 4, text: "Key enzymes" },
  ];
  assert.deepEqual(addFigures(pages, [{ pageNum: 4, text: "Figure: hexokinase step" }, { pageNum: 9, text: "Figure: stray" }]), [
    { pageNum: 3, text: "Glycolysis overview" },
    { pageNum: 4, text: "Key enzymes\n\nFigure: hexokinase step" },
  ]);
});
