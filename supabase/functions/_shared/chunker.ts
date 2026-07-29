// Chunking — port of the extension's course-materials.js splitter
// (CHUNK_MAX_CHARS / CHUNK_OVERLAP_CHARS / sentence-boundary snapping).
// Pure module: no runtime globals.

export const CHUNK_MAX_CHARS = 1700;
export const CHUNK_OVERLAP_CHARS = 140;

// Boundary snap only engages when it lands meaningfully past the chunk start
// (mirrors the extension's `boundary > start + 500` guard).
const MIN_BOUNDARY_ADVANCE = 500;

export interface PageText {
  pageNum: number;
  text: string;
}

export interface PageChunk {
  pageStart: number;
  pageEnd: number;
  ordinalOnPage: number;
  text: string;
}

export function splitTextIntoChunks(text: string): string[] {
  const source = String(text || "").trim();
  if (!source) return [];
  if (source.length <= CHUNK_MAX_CHARS) return [source];

  const chunks: string[] = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(source.length, start + CHUNK_MAX_CHARS);
    if (end < source.length) {
      const boundary = Math.max(
        source.lastIndexOf("\n", end),
        source.lastIndexOf(". ", end),
        source.lastIndexOf("; ", end),
      );
      if (boundary > start + MIN_BOUNDARY_ADVANCE) end = boundary + 1;
    }
    chunks.push(source.slice(start, end).trim());
    if (end >= source.length) break;
    start = Math.max(0, end - CHUNK_OVERLAP_CHARS);
  }
  return chunks.filter(Boolean);
}

export function normalizePages(pages: ReadonlyArray<string | PageText>): PageText[] {
  return (Array.isArray(pages) ? pages : []).map((page, index) => {
    if (typeof page === "string") {
      return { pageNum: index + 1, text: page };
    }
    return {
      pageNum: Number(page?.pageNum ?? index + 1),
      text: String(page?.text ?? ""),
    };
  });
}

// Per-page chunking, matching the extension's buildChunksForDocument shape:
// every chunk stays within one page so citations can open the exact page.
export function chunkPages(pages: ReadonlyArray<string | PageText>): PageChunk[] {
  const chunks: PageChunk[] = [];
  normalizePages(pages).forEach((page) => {
    splitTextIntoChunks(page.text).forEach((text, idx) => {
      chunks.push({
        pageStart: page.pageNum,
        pageEnd: page.pageNum,
        ordinalOnPage: idx,
        text,
      });
    });
  });
  return chunks;
}
