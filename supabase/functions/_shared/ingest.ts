// Ingestion helpers shared by the import pump: turn extracted text into
// embedded content_units, and advance a single source one bounded step.
import { chunkPages, splitTextIntoChunks } from "./chunker.ts";
import type { PageText } from "./chunker.ts";
import { embedTexts, toVectorLiteral } from "./embeddings.ts";
import { service, STORAGE_BUCKET } from "./service.ts";

export interface SourceRow {
  id: string;
  user_id: string;
  course_id: string;
  origin: string;
  source_kind: string;
  canvas_id: string | null;
  title: string;
  folder_path: string | null;
  module_name: string | null;
  canvas_url: string | null;
  storage_path: string | null;
  content_role: string;
  page_count: number;
  pages_parsed: number;
  chunks_embedded: number;
  attempts?: number;
  status: string;
  content_sha256?: string | null;
  needs_refresh?: boolean;
  due_at?: string | null;
}

interface UnitInsert {
  user_id: string;
  course_id: string;
  source_id: string;
  ordinal: number;
  unit_type: "chunk";
  content_role: string;
  heading_path: string | null;
  page_start: number | null;
  page_end: number | null;
  content: string;
  embedding: string;
  embedding_model: string;
}

// Embed a batch of {text, page} chunks for a source and insert them as
// content_units starting at `ordinalStart`. Returns the number inserted.
export async function embedAndInsertChunks(
  source: SourceRow,
  chunks: Array<{ text: string; pageStart: number | null; pageEnd: number | null; heading?: string }>,
  ordinalStart: number,
): Promise<number> {
  if (chunks.length === 0) return 0;

  const embedded = await embedTexts(
    chunks.map((chunk) => chunk.text),
    "RETRIEVAL_DOCUMENT",
  );

  const rows: UnitInsert[] = chunks.map((chunk, i) => ({
    user_id: source.user_id,
    course_id: source.course_id,
    source_id: source.id,
    ordinal: ordinalStart + i,
    unit_type: "chunk",
    content_role: source.content_role,
    heading_path: chunk.heading ?? source.title,
    page_start: chunk.pageStart,
    page_end: chunk.pageEnd,
    content: chunk.text,
    embedding: toVectorLiteral(embedded[i]!.values),
    embedding_model: embedded[i]!.model,
  }));

  // Idempotent on (source_id, ordinal) so a transient-retry re-processing the
  // same page batch can't hit a unique violation.
  const { error } = await service
    .from("polya_content_units")
    .upsert(rows, { onConflict: "source_id,ordinal", ignoreDuplicates: true });
  if (error) throw new Error(`content_unit insert failed: ${error.message}`);
  return rows.length;
}

export async function downloadFromStorage(storagePath: string): Promise<ArrayBuffer> {
  const { data, error } = await service.storage.from(STORAGE_BUCKET).download(storagePath);
  if (error || !data) throw new Error(`storage download failed: ${error?.message}`);
  return await data.arrayBuffer();
}

export async function uploadToStorage(
  storagePath: string,
  bytes: ArrayBuffer | Uint8Array,
  contentType: string,
): Promise<void> {
  const { error } = await service.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, bytes, { contentType, upsert: true });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function storageKeyFor(source: SourceRow, ext: string): string {
  return `${source.user_id}/${source.course_id}/${source.id}/original.${ext}`;
}

// Chunk a plain-text/HTML body into embeddable chunks (single logical page).
export function chunksFromText(text: string): Array<{
  text: string;
  pageStart: null;
  pageEnd: null;
}> {
  return splitTextIntoChunks(text).map((chunk) => ({
    text: chunk,
    pageStart: null,
    pageEnd: null,
  }));
}

// Chunk extracted PDF pages into per-page chunks (keeps citations page-exact).
export function chunksFromPages(pages: PageText[]): Array<{
  text: string;
  pageStart: number;
  pageEnd: number;
}> {
  return chunkPages(pages).map((chunk) => ({
    text: chunk.text,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
  }));
}
