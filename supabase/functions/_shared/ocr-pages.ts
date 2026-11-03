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

/** The Messages API takes PDFs of up to 600 pages on a 1M-context model, and
 * OCR runs on Claude Haiku 5.5, which has one (models with a 200k window stop
 * at 100). Past this, a large scan can't be transcribed whole. It was 100
 * until 2026-11-02, which silently skipped the image-only slides of every
 * deck over 6 MB and 100 pages. */
export const WHOLE_DOC_MAX_PAGES = 600;

/** Lines that describe a picture start with this, so they can be told apart from transcribed text. */
export const FIGURE_LINE_PREFIX = "Figure:";

/** How a transcription describes the pictures on a page, appended to every OCR prompt. */
export const FIGURE_INSTRUCTION =
  `Then, for each figure, chart, diagram, table, or photo on the page, add one line that starts with ` +
  `"${FIGURE_LINE_PREFIX}" and says what it shows, including its labels, axes, values, and any text in it. ` +
  "Skip logos, decorations, and backgrounds.";

/** For a page whose text was already read from the PDF: describe only its pictures. */
export const FIGURE_ONLY_PROMPT =
  "The text on this PDF page has already been read. Describe only its pictures: for each figure, chart, " +
  `diagram, table, or photo, write one line that starts with "${FIGURE_LINE_PREFIX}" and says what it shows, ` +
  "including its labels, axes, values, and any text in it. Skip logos, decorations, and backgrounds. Output " +
  "only those lines. If the page has no pictures, output nothing.";

/** The picture lines in a model's output, one per line, or "" when there are none. */
export function figureLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(FIGURE_LINE_PREFIX) && line.length > FIGURE_LINE_PREFIX.length + 3)
    .join("\n");
}

/** Add each page's picture descriptions under that page's own text. Pages without any are unchanged. */
export function addFigures(pages: readonly PageText[], figures: readonly PageText[]): PageText[] {
  const byPage = new Map(figures.filter((f) => f.text).map((f) => [f.pageNum, f.text]));
  return pages.map((page) => {
    const extra = byPage.get(page.pageNum);
    return extra ? { pageNum: page.pageNum, text: `${page.text}\n\n${extra}` } : page;
  });
}

/**
 * The request for a `total`-page document: transcribe `pageNums` (1-indexed)
 * in full, and for `figurePages` (whose text is already read) describe only
 * their pictures. Every requested page starts with its own marker line.
 */
export function wholeDocumentPrompt(pageNums: number[], total: number, figurePages: number[] = []): string {
  const plural = (list: number[]) => (list.length === 1 ? "page" : "pages");
  const parts = [`This PDF has ${total} pages.`];
  if (pageNums.length > 0) {
    parts.push(
      `Transcribe ALL readable text from ${plural(pageNums)} ${pageNums.join(", ")} (1-indexed), preserving ` +
        "reading order and line breaks. Include text inside figures, tables, and diagrams. Render equations " +
        "and chemical formulae as inline text (e.g. Vmax, [S], H2O, ATP). After a page's text, for each " +
        `figure, chart, diagram, table, or photo on it, add one line that starts with "${FIGURE_LINE_PREFIX}" ` +
        "and says what it shows, including its labels, axes, values, and any text in it (skip logos, " +
        "decorations, and backgrounds).",
    );
  }
  if (figurePages.length > 0) {
    parts.push(
      `The text on ${plural(figurePages)} ${figurePages.join(", ")} has already been read: for ${
        figurePages.length === 1 ? "that page" : "those pages"
      }, write only one "${FIGURE_LINE_PREFIX}" line per figure, chart, diagram, table, or photo, saying ` +
        "what it shows, including its labels, axes, values, and any text in it, and skip logos, decorations, " +
        "and backgrounds.",
    );
  }
  parts.push(
    "Cover no other pages. " +
      `Start each page with a line of exactly "${PAGE_MARKER_PREFIX}n ===" (n = the page number). ` +
      "Output only the markers and that content — no commentary, no headings you invent. If a page has " +
      "nothing to output, output just its marker.",
  );
  return parts.join(" ");
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
