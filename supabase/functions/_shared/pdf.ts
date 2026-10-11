// PDF text extraction — unpdf (serverless pdf.js build; text only, no canvas).
// Extract a bounded page range per call so a large PDF is processed across
// several import-pump invocations without blowing the edge CPU limit.
import { getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";

import type { PageText } from "./chunker.ts";
import { pageTextFromItems } from "./db-text.ts";

const MIN_TEXT_CHARS = 50; // pages below this count as empty (scanned/slide)

export interface PdfInfo {
  totalPages: number;
}

export interface PageRangeResult {
  pages: PageText[]; // only pages with >= MIN_TEXT_CHARS extractable text
  emptyPages: number[]; // 1-indexed page numbers in range with too little text (OCR targets)
  nextPage: number; // resume cursor (1-indexed page to parse next)
  done: boolean;
}

// pdf.js transfers (detaches) the ArrayBuffer it's handed, so always clone
// first — otherwise a caller that reuses the same bytes gets a detached buffer.
function cloneBytes(bytes: ArrayBuffer): Uint8Array {
  return new Uint8Array(bytes.slice(0));
}

export async function getPdfInfo(bytes: ArrayBuffer): Promise<PdfInfo> {
  const pdf = await getDocumentProxy(cloneBytes(bytes));
  return { totalPages: pdf.numPages };
}

// Extract text for pages [startPage, startPage + count) (1-indexed, inclusive
// of startPage). Pages with < MIN_TEXT_CHARS of text are counted empty and
// omitted (they'd contribute noise, and scanned pages need OCR — out of v1).
export async function extractPageRange(
  bytes: ArrayBuffer,
  startPage: number,
  count: number,
): Promise<PageRangeResult> {
  const pdf = await getDocumentProxy(cloneBytes(bytes));
  const total = pdf.numPages;
  const from = Math.max(1, startPage);
  const to = Math.min(total, from + count - 1);

  const pages: PageText[] = [];
  const emptyPages: number[] = [];

  for (let pageNum = from; pageNum <= to; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const text = pageTextFromItems(content.items);

    if (text.length >= MIN_TEXT_CHARS) {
      pages.push({ pageNum, text });
    } else {
      emptyPages.push(pageNum);
    }
  }

  const done = to >= total;
  return { pages, emptyPages, nextPage: to + 1, done };
}

// Heuristic: a source is "needs_ocr" when almost every page had too little
// selectable text (scanned document / image-only slides).
export function isMostlyScanned(emptyPages: number, totalPages: number): boolean {
  if (totalPages === 0) return false;
  return emptyPages / totalPages > 0.6;
}

export { MIN_TEXT_CHARS };
