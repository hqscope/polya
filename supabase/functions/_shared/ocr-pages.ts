// Pure helpers for whole-document OCR (no Deno globals; Node tests import it).
//
// Small PDFs are sliced page-by-page before OCR (ocr.ts). Large scans can't
// be: parsing a 20-30 MB PDF with pdf-lib costs more CPU than one edge
// function invocation is allowed (2 s), so the whole file is uploaded once and
// the model is asked to transcribe the wanted pages, marking each with a
// `=== PAGE n ===` line. These helpers build that prompt and read it back.

import type { PageText } from "./chunker.ts";

export const PAGE_MARKER_PREFIX = "=== PAGE ";

/** PDFs bigger than this skip pdf-lib slicing and go through the Files API.
 * pdf-lib parses the whole file eagerly in JS: a 27 MB scan took ~0.5 s on an
 * M-series laptop (data/ocr-eval, 2026-10-08), so on the slower edge runtime
 * it alone can spend the 2 s CPU budget — and the pump advances up to three
 * sources at once. The 3 MB files in the same course slice fine. */
export const LARGE_PDF_BYTES = 6 * 1024 * 1024;

/** The Messages API refuses PDFs over 100 pages (under a 1M context window),
 * so a large scan beyond that can't be transcribed whole. */
export const WHOLE_DOC_MAX_PAGES = 100;

/** The transcription request for `pageNums` (1-indexed) of a `total`-page document. */
export function wholeDocumentPrompt(pageNums: number[], total: number): string {
  const list = pageNums.join(", ");
  return (
    `This PDF has ${total} pages. Transcribe ALL readable text from ${
      pageNums.length === 1 ? "page" : "pages"
    } ${list} (1-indexed) and no other pages. ` +
    `Start each page with a line of exactly "${PAGE_MARKER_PREFIX}n ===" (n = the page number), then the ` +
    "page's text, preserving reading order and line breaks. Include text inside figures, tables, and " +
    "diagrams. Render equations and chemical formulae as inline text (e.g. Vmax, [S], H2O, ATP). " +
    "Output only the markers and transcribed text — no commentary, no headings you invent. If a page " +
    "has no readable text, output just its marker."
  );
}

/** Split a marker-delimited transcription into per-page text, keeping only the
 * pages that were asked for and that yielded at least `minChars` characters.
 * Text before the first marker is ignored. */
export function splitPageMarkers(text: string, wanted: number[], minChars: number): PageText[] {
  const want = new Set(wanted);
  const seen = new Map<number, string>();
  const pattern = /^[ \t]*=== PAGE (\d+) ===[ \t]*$/gm;
  const matches = [...text.matchAll(pattern)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const pageNum = Number(match[1]);
    const start = match.index! + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length;
    const body = text.slice(start, end).replace(/\s+\n/g, "\n").trim();
    if (!want.has(pageNum) || seen.has(pageNum)) continue; // first occurrence wins
    seen.set(pageNum, body);
  }
  return wanted
    .filter((pageNum) => (seen.get(pageNum)?.length ?? 0) >= minChars)
    .map((pageNum) => ({ pageNum, text: seen.get(pageNum)! }));
}
