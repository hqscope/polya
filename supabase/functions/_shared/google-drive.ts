// Google Drive / Slides / Docs files linked from a course website, fetched as
// PDF bytes for the import pump. Two ways in, tried in order:
//   1. The public export ("anyone with the link"), no account needed.
//   2. The student's own Google account (a read-only Drive grant), for files
//      shared only inside their school's Google domain. See drive-grant.ts.
// Pure module (no Deno globals; fetch is injected) so Node's test runner
// covers it.
//
// READ-ONLY BY CONSTRUCTION: the only Drive calls here are GETs of one file —
// its metadata, its bytes (alt=media) and, for Slides/Docs, a PDF export
// (export only converts a copy for download). There is no create, update,
// copy, move, permission, trash or delete call, and there must never be one.
import {
  FILE_TIMEOUT_MS,
  fetchPublic,
  type FetchLike,
  looksLikePdf,
  readCapped,
  ResponseTooLargeError,
  TransientFetchError,
} from "./safe-fetch.ts";

export type GoogleFileKind = "file" | "slides" | "doc";

export interface GoogleFileRef {
  kind: GoogleFileKind;
  id: string;
}

/** Largest file we'll pull (matches the platform's course-file cap). */
export const MAX_GOOGLE_FILE_BYTES = 50 * 1024 * 1024;

export const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
export const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";
export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const PDF_MIME = "application/pdf";

// Drive file ids are URL-safe base64-ish strings (same bound the platform's
// google_drive_audit.file_id check enforces).
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

export function isDriveId(value: unknown): value is string {
  return typeof value === "string" && DRIVE_ID_RE.test(value);
}

/** Recognizes a Drive file / Slides / Docs link. Folders, Sheets, Forms and published-to-web links return null. */
export function parseGoogleFileLink(raw: string): GoogleFileRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  let kind: GoogleFileKind | null = null;
  let id: string | null = null;

  if (host === "drive.google.com") {
    const byPath = path.match(/^\/file\/(?:u\/\d+\/)?d\/([^/]+)/);
    if (byPath) {
      kind = "file";
      id = byPath[1]!;
    } else if (path === "/open" || path === "/uc") {
      kind = "file";
      id = url.searchParams.get("id");
    }
  } else if (host === "docs.google.com") {
    const match = path.match(/^\/(presentation|document)\/(?:u\/\d+\/)?d\/([^/]+)/);
    // "/d/e/2PACX…" is a published-to-web copy with a different id space.
    if (match && match[2] !== "e") {
      kind = match[1] === "presentation" ? "slides" : "doc";
      id = match[2]!;
    }
  }
  return kind && isDriveId(id) ? { kind, id } : null;
}

/** Stable per-file key for polya_sources.canvas_id, e.g. "slides:1RdQ…". */
export function googleSourceKey(ref: GoogleFileRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function parseGoogleSourceKey(key: string | null | undefined): GoogleFileRef | null {
  const match = String(key ?? "").match(/^(file|slides|doc):(.+)$/);
  if (!match || !isDriveId(match[2])) return null;
  return { kind: match[1] as GoogleFileKind, id: match[2]! };
}

/** Where "Open original" sends the student. */
export function googleViewUrl(ref: GoogleFileRef): string {
  const id = encodeURIComponent(ref.id);
  if (ref.kind === "slides") return `https://docs.google.com/presentation/d/${id}/edit`;
  if (ref.kind === "doc") return `https://docs.google.com/document/d/${id}/edit`;
  return `https://drive.google.com/file/d/${id}/view`;
}

/** The no-account download/export address for a file shared with anyone who has the link. */
export function publicExportUrl(ref: GoogleFileRef): string {
  const id = encodeURIComponent(ref.id);
  if (ref.kind === "slides") return `https://docs.google.com/presentation/d/${id}/export/pdf`;
  if (ref.kind === "doc") return `https://docs.google.com/document/d/${id}/export?format=pdf`;
  // confirm=t skips the "can't scan this file for viruses" page on large files.
  return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
}

function isGoogleContentHost(host: string): boolean {
  return host === "drive.google.com" || host === "docs.google.com" ||
    host === "drive.usercontent.google.com" || host.endsWith(".googleusercontent.com");
}

/**
 * The file as PDF bytes via the public export, or null when Google wants a
 * sign-in (it redirects to accounts.google.com or serves an HTML page).
 */
export async function fetchPublicGooglePdf(
  fetchFn: FetchLike,
  ref: GoogleFileRef,
  maxBytes = MAX_GOOGLE_FILE_BYTES,
): Promise<Uint8Array | null> {
  const response = await fetchPublic(fetchFn, publicExportUrl(ref), {
    maxBytes,
    accept: "application/pdf,*/*",
    allowRedirectHost: isGoogleContentHost,
    timeoutMs: FILE_TIMEOUT_MS,
  });
  if (response.status !== 200) return null;
  return looksLikePdf(response.bytes) ? response.bytes : null;
}

// --- Signed-in reads (Drive API v3 with the student's access token) --------

/** The access token was refused (expired or revoked): refresh once, then give up. */
export class DriveAuthError extends Error {
  constructor() {
    super("drive 401");
    this.name = "DriveAuthError";
  }
}

/** The student's account can't see this file either (not shared with them, or deleted). */
export class DriveNotFoundError extends Error {
  constructor() {
    super("drive not found");
    this.name = "DriveNotFoundError";
  }
}

/** The owner blocked downloads, or the file isn't a PDF, Slides deck, or Doc. */
export class DriveUnreadableError extends Error {
  readonly reason: "no_download" | "unsupported" | "too_large";
  constructor(reason: "no_download" | "unsupported" | "too_large") {
    super(`drive ${reason}`);
    this.name = "DriveUnreadableError";
    this.reason = reason;
  }
}

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  shortcutTargetId: string | null;
}

export interface DrivePdf {
  bytes: Uint8Array;
  meta: DriveFileMeta;
}

/** Maps a Drive error response to a typed error. Never echoes Google's body. */
export function driveError(status: number, body: unknown): Error {
  if (status === 401) return new DriveAuthError();
  if (status === 404) return new DriveNotFoundError();
  const error = (body as { error?: { errors?: Array<{ reason?: string }> } } | null)?.error;
  const reasons = Array.isArray(error?.errors) ? error.errors.map((e) => String(e?.reason ?? "")) : [];
  if (status === 403) {
    if (reasons.some((r) => r === "insufficientPermissions" || r === "insufficientScopes" || r === "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
      return new DriveAuthError();
    }
    if (reasons.some((r) => r === "appNotAuthorizedToFile" || r === "notFound")) return new DriveNotFoundError();
    if (reasons.includes("exportSizeLimitExceeded")) return new DriveUnreadableError("too_large");
    if (reasons.some((r) => r === "cannotDownloadFile" || r === "cannotExportFile" || r === "fileNotDownloadable")) {
      return new DriveUnreadableError("no_download");
    }
    if (reasons.some((r) => r === "userRateLimitExceeded" || r === "rateLimitExceeded")) {
      return new TransientFetchError("drive rate limited");
    }
  }
  if (status === 429 || status >= 500) return new TransientFetchError(`drive (${status})`);
  return new Error(`drive ${status}`);
}

async function driveGet(fetchFn: FetchLike, url: string, token: string, accept: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
      signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new TransientFetchError(`drive unreachable: ${String(error).slice(0, 200)}`);
  }
  if (response.ok) return response;
  const body = await response.json().catch(() => null);
  throw driveError(response.status, body);
}

function fileUrl(id: string): string {
  return `${DRIVE_FILES_URL}/${encodeURIComponent(id)}`;
}

export function driveMetadataUrl(id: string): string {
  const params = new URLSearchParams({
    fields: "id,name,mimeType,modifiedTime,shortcutDetails(targetId)",
    supportsAllDrives: "true",
  });
  return `${fileUrl(id)}?${params}`;
}

export function driveDownloadUrl(id: string): string {
  return `${fileUrl(id)}?${new URLSearchParams({ alt: "media", supportsAllDrives: "true" })}`;
}

export function driveExportPdfUrl(id: string): string {
  return `${fileUrl(id)}/export?${new URLSearchParams({ mimeType: PDF_MIME })}`;
}

export async function fetchDriveMetadata(fetchFn: FetchLike, token: string, id: string): Promise<DriveFileMeta> {
  const response = await driveGet(fetchFn, driveMetadataUrl(id), token, "application/json");
  const raw = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!raw || typeof raw.id !== "string") throw new TransientFetchError("drive metadata shape");
  const shortcut = raw.shortcutDetails as { targetId?: unknown } | undefined;
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name.slice(0, 300) : "",
    mimeType: typeof raw.mimeType === "string" ? raw.mimeType : "",
    modifiedTime: typeof raw.modifiedTime === "string" ? raw.modifiedTime : null,
    shortcutTargetId: typeof shortcut?.targetId === "string" && isDriveId(shortcut.targetId) ? shortcut.targetId : null,
  };
}

/** The file as PDF bytes through the student's own account. Slides and Docs are exported to PDF. */
export async function fetchDrivePdfWithToken(
  fetchFn: FetchLike,
  token: string,
  ref: GoogleFileRef,
  maxBytes = MAX_GOOGLE_FILE_BYTES,
): Promise<DrivePdf> {
  let meta = await fetchDriveMetadata(fetchFn, token, ref.id);
  // A Drive shortcut: follow it once to the file it points at.
  if (meta.mimeType === GOOGLE_SHORTCUT_MIME && meta.shortcutTargetId) {
    meta = await fetchDriveMetadata(fetchFn, token, meta.shortcutTargetId);
  }

  let url: string;
  if (meta.mimeType === PDF_MIME) url = driveDownloadUrl(meta.id);
  else if (meta.mimeType === GOOGLE_SLIDES_MIME || meta.mimeType === GOOGLE_DOC_MIME) url = driveExportPdfUrl(meta.id);
  else throw new DriveUnreadableError("unsupported");

  const response = await driveGet(fetchFn, url, token, PDF_MIME);
  let bytes: Uint8Array;
  try {
    bytes = await readCapped(response, maxBytes);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) throw new DriveUnreadableError("too_large");
    throw new TransientFetchError(`drive read failed: ${String(error).slice(0, 200)}`);
  }
  if (!looksLikePdf(bytes)) throw new DriveUnreadableError("unsupported");
  return { bytes, meta };
}
