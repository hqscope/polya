// Server-side checks for files a student uploads straight to storage and then
// registers with polya-import `add_upload`. The browser picks the kind and the
// path, so neither is trusted: the kind must be on this allowlist, the path
// must sit in the student's own uploads folder with the matching extension,
// and a PDF's bytes must actually start like a PDF. Pure module: no runtime
// globals.

export interface UploadSpec {
  origin: "upload_transcript" | "upload_file";
  sourceKind: string;
  ext: string;
}

const UPLOAD_SPECS: Record<string, UploadSpec> = {
  transcript_txt: { origin: "upload_transcript", sourceKind: "transcript_txt", ext: "txt" },
  transcript_json: { origin: "upload_transcript", sourceKind: "transcript_json", ext: "json" },
  transcript_vtt: { origin: "upload_transcript", sourceKind: "transcript_vtt", ext: "vtt" },
  transcript_srt: { origin: "upload_transcript", sourceKind: "transcript_srt", ext: "srt" },
  pdf: { origin: "upload_file", sourceKind: "pdf", ext: "pdf" },
};

// Matches the polya_documents bucket's own per-file limit (30 MiB), so a file
// the bucket would refuse is refused here first, with friendlier words.
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
// Each 10-page parse step re-reads the whole file; past this, ask for the
// chapters that matter instead of a whole book.
export const MAX_UPLOAD_PAGES = 300;
export const MAX_UPLOAD_TITLE_CHARS = 200;

export const UPLOAD_TOO_LARGE_MESSAGE =
  "That file is over 30 MB. Try uploading just the chapters or pages you need.";
export const UPLOAD_TOO_MANY_PAGES_MESSAGE =
  `That file is over ${MAX_UPLOAD_PAGES} pages. Try uploading just the chapters you need.`;
export const UPLOAD_NOT_PDF_MESSAGE = "That file couldn't be opened as a PDF.";

export function uploadSpecFor(kind: unknown): UploadSpec | null {
  return typeof kind === "string" && Object.hasOwn(UPLOAD_SPECS, kind) ? UPLOAD_SPECS[kind]! : null;
}

const UPLOAD_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.([a-z0-9]+)$/;

/** The upload's storage path must be `<uid>/uploads/<uuid>.<ext>` for this kind. */
export function isValidUploadPath(userId: string, storagePath: unknown, spec: UploadSpec): boolean {
  if (typeof storagePath !== "string") return false;
  const prefix = `${userId}/uploads/`;
  if (!storagePath.startsWith(prefix)) return false;
  const match = UPLOAD_NAME_RE.exec(storagePath.slice(prefix.length));
  return match !== null && match[1] === spec.ext;
}

/** A display title from the client's file name: trimmed, single-line, capped. */
export function cleanUploadTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const title = raw.replace(/\s+/g, " ").trim().slice(0, MAX_UPLOAD_TITLE_CHARS).trim();
  return title || null;
}

/** PDF readers accept the `%PDF-` header anywhere in the first 1 KB. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 1024) - 5;
  for (let i = 0; i <= end; i++) {
    if (
      bytes[i] === 0x25 && // %
      bytes[i + 1] === 0x50 && // P
      bytes[i + 2] === 0x44 && // D
      bytes[i + 3] === 0x46 && // F
      bytes[i + 4] === 0x2d // -
    ) {
      return true;
    }
  }
  return false;
}
