// Google Drive for Polya: Drive/Docs links, the token calls for the student's
// own read-only Drive grant (connect, refresh, revoke), and Drive v3 reads
// with it (metadata, folder listings, file bytes and exports).
//
// Why a student grant at all: course files shared only with a school's Google
// domain ("Anyone at UC Berkeley with the link") can't be fetched publicly, and
// a service account isn't in that domain. The grant is the platform's
// google_tokens 'drive' row (shared with the Scope extension).
// docs/DRIVE-SETUP.md has the Google Cloud setup.
//
// Pure module (no Deno globals; fetch is injected) so Node's test runner
// covers it. Callers: drive-grant.ts (the import pump's reader),
// drive-connection.ts + polya-google (connect / status / disconnect).
// google-drive.ts (course-site pipeline) still has its own single-file reads.
//
// READ-ONLY BY CONSTRUCTION: the only Drive calls here are GETs: file
// metadata, folder listings, file bytes (alt=media) and exports (export only
// converts a copy for download). There is no create, update, copy, move,
// permission, trash or delete call, and there must never be one. The token
// endpoints act on Polya's own grant, not on anything in the student's Drive.
import {
  type FetchLike,
  looksLikePdf,
  readCapped,
  ResponseTooLargeError,
  TransientFetchError,
} from "./safe-fetch.ts";

export type { FetchLike } from "./safe-fetch.ts";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
/**
 * What Polya asks Google for. Same set as the extension's Drive connect, so
 * one grant serves both. drive.readonly is a restricted scope: until Google's
 * verification and CASA assessment, only the google_drive_full_read allowlist
 * can connect (see docs/DRIVE-SETUP.md).
 */
export const GRANT_SCOPES: readonly string[] = ["openid", "email", DRIVE_READONLY_SCOPE];

/** Where Google sends the student back to Polya (src/app/auth/google-drive/callback). */
export const CONNECT_CALLBACK_PATH = "/auth/google-drive/callback";

/** Largest file we'll pull (matches the platform's course-file cap). */
export const MAX_GOOGLE_FILE_BYTES = 50 * 1024 * 1024;
/** Default ceiling on entries one listFolder call returns (recursion included). */
export const MAX_LIST_ITEMS = 5_000;

export const PDF_MIME = "application/pdf";
export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
export const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";
export const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const GOOGLE_DRAWING_MIME = "application/vnd.google-apps.drawing";
export const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
export const GOOGLE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const GOOGLE_APPS_PREFIX = "application/vnd.google-apps.";

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

// Drive file and folder ids are URL-safe base64-ish strings (same bound the
// platform's google_drive_audit.file_id check enforces).
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const RESOURCE_KEY_RE = /^[A-Za-z0-9_-]{1,100}$/;

export function isDriveId(value: unknown): value is string {
  return typeof value === "string" && DRIVE_ID_RE.test(value);
}

/** The Docs editor a docs.google.com link opens. */
export type DriveDocType = "document" | "presentation" | "spreadsheets" | "drawings";
const DOC_TYPES: ReadonlySet<string> = new Set(["document", "presentation", "spreadsheets", "drawings"]);

export interface DriveLink {
  kind: "file" | "folder";
  id: string;
  /** Set for docs.google.com links: which editor the link opens. */
  docType?: DriveDocType;
  /**
   * The `resourcekey` from links to files shared before Google's 2021
   * link-sharing security update. Pass it back as `resourceKey` when reading.
   */
  resourceKey?: string;
}

// Path segments with the account selector (`/u/1/`) and the legacy domain
// prefix (`/a/berkeley.edu/`) removed, wherever they appear.
function pathSegments(pathname: string): string[] {
  const parts = pathname.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const next = parts[i + 1] ?? "";
    if (parts[i] === "u" && /^\d+$/.test(next)) {
      i++;
      continue;
    }
    if (parts[i] === "a" && next.includes(".")) {
      i++;
      continue;
    }
    out.push(parts[i]!);
  }
  return out;
}

/**
 * Recognizes a Drive file or folder link:
 *   drive.google.com/file/d/<id>/view?usp=sharing   (also /u/1/, /a/<domain>/, /edit, /preview)
 *   drive.google.com/open?id=<id>, /uc?id=<id>&export=download
 *   drive.google.com/drive/folders/<id>              (also /drive/u/0/folders/, /drive/mobile/folders/)
 *   drive.google.com/folderview?id=<id>, /embeddedfolderview?id=<id>
 *   docs.google.com/{document,presentation,spreadsheets,drawings}/d/<id>/edit?usp=sharing
 *   drive.usercontent.google.com/download?id=<id>
 * `/open?id=` can name a folder too; it reads as "file" (stat() says which).
 * Published-to-web links (`/d/e/2PACX…`) use a different id space and return
 * undefined, as do Forms, Sites and anything that isn't Drive.
 */
export function parseDriveLink(raw: string): DriveLink | undefined {
  if (typeof raw !== "string") return undefined;
  // Links scraped from HTML sometimes keep their entity-encoded ampersands.
  let text = raw.trim().replace(/&amp;/g, "&");
  if (!text) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;

  const host = url.hostname.toLowerCase();
  const segs = pathSegments(url.pathname);
  const idParam = url.searchParams.get("id");
  const key = url.searchParams.get("resourcekey");
  const resourceKey = key && RESOURCE_KEY_RE.test(key) ? key : undefined;

  const link = (kind: DriveLink["kind"], id: string | null | undefined, docType?: DriveDocType): DriveLink | undefined => {
    if (!isDriveId(id)) return undefined;
    const out: DriveLink = { kind, id };
    if (docType) out.docType = docType;
    if (resourceKey) out.resourceKey = resourceKey;
    return out;
  };

  if (host === "drive.google.com") {
    if (segs[0] === "file" && segs[1] === "d") return link("file", segs[2]);
    if (segs[0] === "drive") {
      const at = segs.indexOf("folders");
      return at > 0 ? link("folder", segs[at + 1]) : undefined;
    }
    if (segs[0] === "folderview" || segs[0] === "embeddedfolderview") return link("folder", idParam);
    if (segs[0] === "open" || segs[0] === "uc") return link("file", idParam);
    return undefined;
  }
  if (host === "docs.google.com") {
    const type = segs[0] ?? "";
    if (DOC_TYPES.has(type) && segs[1] === "d") {
      // "/d/e/2PACX…" is a published-to-web copy with a different id space.
      return segs[2] === "e" ? undefined : link("file", segs[2], type as DriveDocType);
    }
    if (segs[0] === "file" && segs[1] === "d") return link("file", segs[2]);
    if (segs[0] === "open" || segs[0] === "uc") return link("file", idParam);
    return undefined;
  }
  if (host === "drive.usercontent.google.com") {
    return segs[0] === "download" || segs[0] === "uc" ? link("file", idParam) : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Errors. Messages are for logs; none echoes Google's response body.
// ---------------------------------------------------------------------------

/** The grant can't be used (expired, revoked, or missing the Drive scope): the student reconnects. */
export class DriveAuthError extends Error {
  constructor(message = "drive 401") {
    super(message);
    this.name = "DriveAuthError";
  }
}

/**
 * Drive answered 404. Drive says "not found" both for a file that doesn't
 * exist and for one this account isn't allowed to see, so this means "wrong
 * or deleted link, or not shared with this Google account".
 */
export class DriveNotFoundError extends Error {
  constructor(message = "drive not found") {
    super(message);
    this.name = "DriveNotFoundError";
  }
}

/**
 * Drive answered 403 for this file: the account knows it exists but may not
 * read it (`not_shared`), or the student's school blocks this app from Drive
 * (`admin_policy`, Workspace `domainPolicy`).
 */
export type DriveDeniedReason = "not_shared" | "admin_policy";
export class DriveAccessDeniedError extends Error {
  readonly reason: DriveDeniedReason;
  constructor(reason: DriveDeniedReason = "not_shared") {
    super(`drive denied: ${reason}`);
    this.name = "DriveAccessDeniedError";
    this.reason = reason;
  }
}

/** The owner blocked downloads, the type can't be read, or it's over the size cap. */
export type DriveUnreadableReason = "no_download" | "unsupported" | "too_large";
export class DriveUnreadableError extends Error {
  readonly reason: DriveUnreadableReason;
  constructor(reason: DriveUnreadableReason) {
    super(`drive ${reason}`);
    this.name = "DriveUnreadableError";
    this.reason = reason;
  }
}

/**
 * Polya's Google setup is wrong, so every read fails the same way: the Drive
 * API is off in the OAuth client's Cloud project (`api_disabled`), or Google
 * rejected the client id/secret (`client`). Not the student's fault.
 */
export type DriveSetupReason = "api_disabled" | "client";
export class DriveSetupError extends Error {
  readonly reason: DriveSetupReason;
  constructor(reason: DriveSetupReason) {
    super(`drive setup: ${reason}`);
    this.name = "DriveSetupError";
    this.reason = reason;
  }
}

/** Retryable (429, 5xx, rate limit, network). A TransientFetchError, so process.ts re-queues it. */
export class DriveTransientError extends TransientFetchError {
  /** Google's HTTP status, or null when Google wasn't reached. */
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "DriveTransientError";
    this.status = status;
  }
}

const SCOPE_REASONS = new Set(["insufficientPermissions", "insufficientScopes", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "authError"]);
const RATE_REASONS = new Set([
  "userRateLimitExceeded",
  "rateLimitExceeded",
  "RATE_LIMIT_EXCEEDED",
  "sharingRateLimitExceeded",
  "dailyLimitExceeded",
  "quotaExceeded",
]);
const NO_DOWNLOAD_REASONS = new Set(["cannotDownloadFile", "cannotExportFile", "fileNotDownloadable", "cannotDownloadAbusiveFile"]);
const SETUP_REASONS = new Set(["accessNotConfigured", "SERVICE_DISABLED"]);

// `error.errors[].reason` (Drive v3) plus `error.details[].reason` (newer ErrorInfo shape).
function errorReasons(body: unknown): string[] {
  const error = (body as { error?: { errors?: unknown; details?: unknown } } | null)?.error;
  const out: string[] = [];
  for (const list of [error?.errors, error?.details]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const reason = (entry as { reason?: unknown } | null)?.reason;
      if (typeof reason === "string") out.push(reason);
    }
  }
  return out;
}

/** Maps a Drive error response to a typed error. Never echoes Google's body. */
export function driveError(status: number, body: unknown): Error {
  if (status === 401) return new DriveAuthError();
  if (status === 404) return new DriveNotFoundError();
  if (status === 403) {
    const reasons = errorReasons(body);
    const has = (set: ReadonlySet<string>) => reasons.some((reason) => set.has(reason));
    if (has(SETUP_REASONS)) return new DriveSetupError("api_disabled");
    if (has(SCOPE_REASONS)) return new DriveAuthError("drive scope missing");
    if (has(RATE_REASONS)) return new DriveTransientError("drive rate limited", 403);
    if (reasons.includes("appNotAuthorizedToFile") || reasons.includes("notFound")) return new DriveNotFoundError();
    if (reasons.includes("exportSizeLimitExceeded")) return new DriveUnreadableError("too_large");
    if (has(NO_DOWNLOAD_REASONS)) return new DriveUnreadableError("no_download");
    if (reasons.includes("domainPolicy")) return new DriveAccessDeniedError("admin_policy");
    return new DriveAccessDeniedError("not_shared");
  }
  if (status === 429 || status >= 500) return new DriveTransientError(`drive (${status})`, status);
  return new Error(`drive ${status}`);
}

/** google_drive_audit outcomes this module can produce. */
export type DriveAuditOutcome =
  | "ok"
  | "not_found"
  | "too_large"
  | "unsupported"
  | "drive_auth"
  | "drive_http"
  | "drive_unreachable"
  | "error";

/** How a failed read is recorded in google_drive_audit. */
export function auditOutcomeFor(error: unknown): { outcome: DriveAuditOutcome; driveStatus: number | null } {
  if (error instanceof DriveNotFoundError) return { outcome: "not_found", driveStatus: 404 };
  if (error instanceof DriveAuthError) return { outcome: "drive_auth", driveStatus: 401 };
  if (error instanceof DriveUnreadableError) {
    return error.reason === "no_download"
      ? { outcome: "drive_http", driveStatus: 403 }
      : { outcome: error.reason, driveStatus: null };
  }
  if (error instanceof DriveAccessDeniedError || error instanceof DriveSetupError) {
    return { outcome: "drive_http", driveStatus: 403 };
  }
  if (error instanceof DriveTransientError) {
    return error.status === null
      ? { outcome: "drive_unreachable", driveStatus: null }
      : { outcome: "drive_http", driveStatus: error.status };
  }
  return { outcome: "error", driveStatus: null };
}

// ---------------------------------------------------------------------------
// The student's grant: token endpoint calls (fetch injected)
// ---------------------------------------------------------------------------

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface TokenGrant {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Present on a code exchange (access_type=offline + prompt=consent); usually absent on refresh. */
  refreshToken: string | null;
  scopes: string[];
  email: string | null;
}

export function parseScopes(scope: unknown): string[] {
  if (typeof scope !== "string") return [];
  return scope.split(" ").map((s) => s.trim()).filter(Boolean);
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
}

/**
 * The email claim of an ID token that came straight from Google's token
 * endpoint over TLS. OIDC allows skipping the signature check in that case,
 * and the email is only shown back to its owner as "Connected as …".
 */
export function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]!)) as { email?: unknown } | null;
    const email = typeof payload?.email === "string" ? payload.email.trim() : "";
    return email && email.length <= 320 ? email : null;
  } catch {
    return null;
  }
}

async function postForm(
  fetchFn: FetchLike,
  url: string,
  params: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  } catch {
    // The thrown error can't carry the form (it holds secrets), so it's dropped.
    throw new DriveTransientError("google token endpoint unreachable");
  }
  const body: unknown = await response.json().catch(() => ({}));
  return {
    status: response.status,
    body: body && typeof body === "object" ? (body as Record<string, unknown>) : {},
  };
}

function grantFrom(status: number, body: Record<string, unknown>): TokenGrant {
  if (status >= 200 && status < 300 && typeof body.access_token === "string" && body.access_token) {
    return {
      accessToken: body.access_token,
      expiresIn: typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600,
      refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
      scopes: parseScopes(body.scope),
      email: emailFromIdToken(body.id_token),
    };
  }
  const code = typeof body.error === "string" ? body.error : "";
  // invalid_grant: the code was used or expired, or the refresh token was
  // revoked or expired (grants from a Testing-status app last 7 days).
  if (code === "invalid_grant") throw new DriveAuthError("google invalid_grant");
  if (code === "invalid_client" || code === "unauthorized_client") throw new DriveSetupError("client");
  if (status === 429 || status >= 500) throw new DriveTransientError(`google token endpoint ${status}`, status);
  // Only Google's error code, never its body: it can echo the request.
  throw new Error(`google token endpoint ${status}${code ? ` ${code}` : ""}`);
}

/** Trades the authorization code from Google's redirect for a grant (PKCE). */
export async function exchangeCode(
  fetchFn: FetchLike,
  creds: ClientCredentials,
  input: { code: string; codeVerifier: string; redirectUri: string },
): Promise<TokenGrant> {
  const { status, body } = await postForm(fetchFn, TOKEN_URL, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  return grantFrom(status, body);
}

export async function refreshAccessToken(
  fetchFn: FetchLike,
  creds: ClientCredentials,
  refreshToken: string,
): Promise<TokenGrant> {
  const { status, body } = await postForm(fetchFn, TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  return grantFrom(status, body);
}

/** Revokes the grant at Google (revoking the refresh token ends the whole grant). True if Google confirmed. */
export async function revokeToken(fetchFn: FetchLike, token: string): Promise<boolean> {
  try {
    const { status } = await postForm(fetchFn, REVOKE_URL, { token });
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}

/** True while a cached access token has more than `skewMs` left. */
export function accessTokenFresh(expiresAt: string | null | undefined, now: Date, skewMs = 60_000): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at - now.getTime() > skewMs;
}

/**
 * The redirect URI a connect may exchange a code for: Polya's callback path on
 * an https origin, or on http://localhost / 127.0.0.1 for local development.
 * Google separately requires the exact URI to be registered on the client.
 */
export function isConnectRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 300) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.pathname !== CONNECT_CALLBACK_PATH || url.search || url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return url.hostname.includes(".");
  if (url.protocol === "http:") return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return false;
}

// ---------------------------------------------------------------------------
// Drive v3 reads
// ---------------------------------------------------------------------------

export type SheetsFormat = "csv" | "pdf";

export type DownloadPlan =
  | { action: "download" }
  | { action: "export"; mimeType: string; extension: string }
  | { action: "folder" }
  | { action: "unsupported" };

/**
 * How fetchFile gets bytes for a Drive mime type: Docs, Slides and Drawings
 * export to PDF; Sheets to CSV (first sheet only, a Drive limit) or PDF;
 * Forms, Sites, Maps, Apps Script and other Google-native types can't be
 * exported; everything else (PDF, .ipynb, images, …) downloads as-is.
 */
export function downloadPlan(mimeType: string, sheetsAs: SheetsFormat = "csv"): DownloadPlan {
  if (mimeType === GOOGLE_FOLDER_MIME) return { action: "folder" };
  if (!mimeType.startsWith(GOOGLE_APPS_PREFIX)) return { action: "download" };
  switch (mimeType) {
    case GOOGLE_DOC_MIME:
    case GOOGLE_SLIDES_MIME:
    case GOOGLE_DRAWING_MIME:
      return { action: "export", mimeType: PDF_MIME, extension: ".pdf" };
    case GOOGLE_SHEET_MIME:
      return sheetsAs === "pdf"
        ? { action: "export", mimeType: PDF_MIME, extension: ".pdf" }
        : { action: "export", mimeType: "text/csv", extension: ".csv" };
    default:
      return { action: "unsupported" };
  }
}

/** The file name to save the bytes under: exports get their extension ("Lecture 5" → "Lecture 5.pdf"). */
export function downloadName(name: string, plan: DownloadPlan): string {
  if (plan.action !== "export") return name;
  return name.toLowerCase().endsWith(plan.extension) ? name : `${name}${plan.extension}`;
}

/** Drive query-language string literal: backslash and single quote escaped. */
export function driveLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** The X-Goog-Drive-Resource-Keys header value for files that need one, or null. */
export function resourceKeyHeader(pairs: ReadonlyArray<readonly [string, string | undefined]>): string | null {
  const parts = pairs.filter(([, key]) => key).map(([id, key]) => `${id}/${key}`);
  return parts.length ? parts.join(",") : null;
}

const ITEM_FIELDS =
  "id,name,mimeType,modifiedTime,size,md5Checksum,resourceKey,parents,webViewLink," +
  "capabilities(canDownload),shortcutDetails(targetId,targetMimeType,targetResourceKey)";

function fileUrl(id: string): string {
  return `${DRIVE_FILES_URL}/${encodeURIComponent(id)}`;
}

export function driveMetadataUrl(id: string): string {
  const params = new URLSearchParams({ fields: `${ITEM_FIELDS},exportLinks`, supportsAllDrives: "true" });
  return `${fileUrl(id)}?${params}`;
}

export function driveDownloadUrl(id: string): string {
  return `${fileUrl(id)}?${new URLSearchParams({ alt: "media", supportsAllDrives: "true" })}`;
}

export function driveExportUrl(id: string, mimeType: string): string {
  return `${fileUrl(id)}/export?${new URLSearchParams({ mimeType })}`;
}

export function driveExportPdfUrl(id: string): string {
  return driveExportUrl(id, PDF_MIME);
}

/** One page of a folder's children (trash excluded), shared drives included. */
export function driveListUrl(folderId: string, pageToken?: string): string {
  const params = new URLSearchParams({
    q: `${driveLiteral(folderId)} in parents and trashed = false`,
    fields: `nextPageToken,files(${ITEM_FIELDS})`,
    pageSize: "1000",
    orderBy: "folder,name",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (pageToken) params.set("pageToken", pageToken);
  return `${DRIVE_FILES_URL}?${params}`;
}

export interface DriveItem {
  /** The file's id. For a shortcut, the id of the file it points at. */
  id: string;
  name: string;
  /** For a shortcut, the target's type. */
  mimeType: string;
  isFolder: boolean;
  /** "/"-joined names from the listed folder down, e.g. "Lab 1/lab01.ipynb" ("/" inside a name becomes "_"). */
  path: string;
  /** The folder this entry was listed under. */
  parentId?: string;
  /** RFC 3339. Absent for shortcuts (it would describe the shortcut, not the file). */
  modifiedTime?: string;
  /** Bytes. Absent for Google Docs/Sheets/Slides, folders and shortcuts. */
  size?: number;
  md5Checksum?: string;
  /** False when the owner turned off downloading for viewers. */
  canDownload?: boolean;
  resourceKey?: string;
  /** Set when this entry is a shortcut, resolved to its target above. */
  shortcutId?: string;
  webViewLink?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  /** The Drive type, e.g. application/vnd.google-apps.presentation. */
  mimeType: string;
  modifiedTime: string;
  data: Uint8Array;
  /** Set when the file was exported: the type of `data` (application/pdf, text/csv). */
  exportedAs?: string;
  /** `name` with the extension matching `data`. */
  fileName: string;
}

/** One file's metadata as fetchPdf reports it. */
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

export interface ListFolderOptions {
  /** Descend into subfolders (and folder shortcuts), each folder once. */
  recursive?: boolean;
  /** Throw DriveUnreadableError("too_large") past this many entries (default MAX_LIST_ITEMS). */
  maxItems?: number;
  resourceKey?: string;
}

export interface FetchFileOptions {
  /** Default MAX_GOOGLE_FILE_BYTES. */
  maxBytes?: number;
  /** Sheets export format (default "csv"). */
  sheetsAs?: SheetsFormat;
  resourceKey?: string;
}

/**
 * The access token for each request: a fixed token (a 401 is final), or a
 * function that can refresh (a 401 refreshes once and retries).
 */
export type AccessTokenSource = string | ((opts: { forceRefresh: boolean }) => Promise<string>);

export interface DriveClient {
  /** Metadata for one file or folder, following a shortcut once. Downloads nothing. */
  stat(id: string, opts?: { resourceKey?: string }): Promise<DriveItem>;
  /** A folder's entries (folders included), paginated, shared drives included. */
  listFolder(folderId: string, opts?: ListFolderOptions): Promise<DriveItem[]>;
  /** One file's bytes: Docs/Slides/Drawings as PDF, Sheets as CSV (or PDF), everything else as-is. */
  fetchFile(fileId: string, opts?: FetchFileOptions): Promise<DriveFile>;
  /** A PDF, Slides deck or Doc as PDF bytes; anything else is DriveUnreadableError("unsupported"). */
  fetchPdf(fileId: string, opts?: { maxBytes?: number; resourceKey?: string }): Promise<DrivePdf>;
}

interface RawFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: number;
  md5Checksum?: string;
  resourceKey?: string;
  webViewLink?: string;
  canDownload?: boolean;
  shortcutTargetId?: string;
  shortcutTargetMimeType?: string;
  shortcutTargetResourceKey?: string;
  exportLinks: Record<string, string>;
}

function str(value: unknown, max = 2048): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

/** A Drive files resource with only the fields we use, type-checked; null if it has no usable id. */
function rawFile(json: unknown): RawFile | null {
  if (!json || typeof json !== "object") return null;
  const raw = json as Record<string, unknown>;
  const id = str(raw.id, 200);
  if (!isDriveId(id)) return null;
  const capabilities = raw.capabilities as { canDownload?: unknown } | undefined;
  const shortcut = raw.shortcutDetails as Record<string, unknown> | undefined;
  const size = Number(raw.size);
  const exportLinks: Record<string, string> = {};
  if (raw.exportLinks && typeof raw.exportLinks === "object") {
    for (const [type, link] of Object.entries(raw.exportLinks as Record<string, unknown>)) {
      if (typeof link === "string") exportLinks[type] = link;
    }
  }
  const targetId = str(shortcut?.targetId, 200);
  return {
    id,
    name: (str(raw.name, 10_000) ?? id).slice(0, 300),
    mimeType: str(raw.mimeType, 255) ?? "",
    modifiedTime: str(raw.modifiedTime, 64),
    size: raw.size !== undefined && Number.isFinite(size) && size >= 0 ? size : undefined,
    md5Checksum: str(raw.md5Checksum, 64),
    resourceKey: str(raw.resourceKey, 100),
    webViewLink: str(raw.webViewLink),
    canDownload: typeof capabilities?.canDownload === "boolean" ? capabilities.canDownload : undefined,
    shortcutTargetId: isDriveId(targetId) ? targetId : undefined,
    shortcutTargetMimeType: str(shortcut?.targetMimeType, 255),
    shortcutTargetResourceKey: str(shortcut?.targetResourceKey, 100),
    exportLinks,
  };
}

/** One listed (or stat-ed) entry as a DriveItem, resolving a shortcut to its target. */
export function toDriveItem(json: unknown, parentPath: string, parentId?: string): DriveItem | null {
  const raw = rawFile(json);
  if (!raw) return null;
  const segment = raw.name.replace(/\//g, "_");
  const path = parentPath ? `${parentPath}/${segment}` : segment;
  const base: Pick<DriveItem, "name" | "path" | "parentId" | "webViewLink"> = { name: raw.name, path };
  if (parentId) base.parentId = parentId;
  if (raw.webViewLink) base.webViewLink = raw.webViewLink;

  if (raw.mimeType === GOOGLE_SHORTCUT_MIME && raw.shortcutTargetId) {
    const mimeType = raw.shortcutTargetMimeType ?? "";
    const item: DriveItem = { ...base, id: raw.shortcutTargetId, mimeType, isFolder: mimeType === GOOGLE_FOLDER_MIME, shortcutId: raw.id };
    if (raw.shortcutTargetResourceKey) item.resourceKey = raw.shortcutTargetResourceKey;
    return item;
  }

  const item: DriveItem = { ...base, id: raw.id, mimeType: raw.mimeType, isFolder: raw.mimeType === GOOGLE_FOLDER_MIME };
  if (raw.modifiedTime) item.modifiedTime = raw.modifiedTime;
  if (raw.size !== undefined) item.size = raw.size;
  if (raw.md5Checksum) item.md5Checksum = raw.md5Checksum;
  if (raw.canDownload !== undefined) item.canDownload = raw.canDownload;
  if (raw.resourceKey) item.resourceKey = raw.resourceKey;
  return item;
}

function toFileMeta(raw: RawFile): DriveFileMeta {
  return {
    id: raw.id,
    name: raw.name,
    mimeType: raw.mimeType,
    modifiedTime: raw.modifiedTime ?? null,
    shortcutTargetId: raw.shortcutTargetId ?? null,
  };
}

// Pages per folder before we assume Google is looping us.
const MAX_PAGES_PER_FOLDER = 200;

/** A Drive client reading as whoever `token` belongs to. */
export function createDriveClient(fetchFn: FetchLike, token: AccessTokenSource): DriveClient {
  const canRefresh = typeof token === "function";
  const accessToken = (forceRefresh: boolean): Promise<string> =>
    typeof token === "function" ? token({ forceRefresh }) : Promise.resolve(token);

  async function get(
    url: string,
    accept: string,
    keys: ReadonlyArray<readonly [string, string | undefined]>,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await accessToken(attempt > 0)}`,
        Accept: accept,
      };
      const keyHeader = resourceKeyHeader(keys);
      if (keyHeader) headers["X-Goog-Drive-Resource-Keys"] = keyHeader;

      let response: Response;
      try {
        response = await fetchFn(url, { method: "GET", headers });
      } catch (error) {
        throw new DriveTransientError(`drive unreachable: ${String(error).slice(0, 200)}`);
      }
      if (response.ok) return response;
      if (response.status === 401 && attempt === 0 && canRefresh) {
        await response.body?.cancel().catch(() => {});
        continue; // the token expired early or was revoked: refresh once
      }
      const body: unknown = await response.json().catch(() => null);
      throw driveError(response.status, body);
    }
  }

  async function readBody(response: Response, maxBytes: number): Promise<Uint8Array> {
    try {
      return await readCapped(response, maxBytes);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) throw new DriveUnreadableError("too_large");
      throw new DriveTransientError(`drive read failed: ${String(error).slice(0, 200)}`);
    }
  }

  async function metadata(id: string, resourceKey?: string): Promise<RawFile> {
    const response = await get(driveMetadataUrl(id), "application/json", [[id, resourceKey]]);
    const raw = rawFile(await response.json().catch(() => null));
    if (!raw) throw new DriveTransientError("drive metadata shape");
    return raw;
  }

  // Follows a shortcut once; a shortcut to a shortcut is left as-is.
  async function resolve(id: string, resourceKey?: string): Promise<RawFile> {
    const raw = await metadata(id, resourceKey);
    if (raw.mimeType === GOOGLE_SHORTCUT_MIME && raw.shortcutTargetId) {
      return metadata(raw.shortcutTargetId, raw.shortcutTargetResourceKey);
    }
    return raw;
  }

  async function exportBytes(raw: RawFile, mimeType: string, maxBytes: number): Promise<Uint8Array> {
    const keys = [[raw.id, raw.resourceKey]] as const;
    let response: Response;
    try {
      response = await get(driveExportUrl(raw.id, mimeType), mimeType, keys);
    } catch (error) {
      // files.export stops at 10 MB. The Docs editors' own export link has no
      // such limit and takes the same token; only Google's docs host gets it.
      const link = raw.exportLinks[mimeType];
      const tooBig = error instanceof DriveUnreadableError && error.reason === "too_large";
      if (!tooBig || !link || !isDocsExportLink(link)) throw error;
      response = await get(link, mimeType, keys);
    }
    return readBody(response, maxBytes);
  }

  async function download(raw: RawFile, maxBytes: number): Promise<Uint8Array> {
    if (raw.size !== undefined && raw.size > maxBytes) throw new DriveUnreadableError("too_large");
    return readBody(await get(driveDownloadUrl(raw.id), "*/*", [[raw.id, raw.resourceKey]]), maxBytes);
  }

  return {
    async stat(id, opts = {}) {
      const raw = await resolve(id, opts.resourceKey);
      const item = toDriveItem(raw, "");
      if (!item) throw new DriveTransientError("drive metadata shape");
      return item;
    },

    async listFolder(folderId, opts = {}) {
      const root = await resolve(folderId, opts.resourceKey);
      if (root.mimeType !== GOOGLE_FOLDER_MIME) throw new Error("drive: not a folder");
      const maxItems = opts.maxItems ?? MAX_LIST_ITEMS;
      const items: DriveItem[] = [];
      const seen = new Set<string>([root.id]);
      const queue: Array<{ id: string; path: string; resourceKey?: string }> = [
        { id: root.id, path: "", resourceKey: root.resourceKey },
      ];
      for (let i = 0; i < queue.length; i++) {
        const folder = queue[i]!;
        let pageToken: string | undefined;
        let pages = 0;
        do {
          if (++pages > MAX_PAGES_PER_FOLDER) throw new DriveTransientError("drive list did not end");
          const response = await get(driveListUrl(folder.id, pageToken), "application/json", [[folder.id, folder.resourceKey]]);
          const page = (await response.json().catch(() => null)) as { files?: unknown; nextPageToken?: unknown } | null;
          if (!page || !Array.isArray(page.files)) throw new DriveTransientError("drive list shape");
          for (const entry of page.files) {
            const item = toDriveItem(entry, folder.path, folder.id);
            if (!item) continue;
            items.push(item);
            if (items.length > maxItems) throw new DriveUnreadableError("too_large");
            if (opts.recursive && item.isFolder && !seen.has(item.id)) {
              seen.add(item.id);
              queue.push({ id: item.id, path: item.path, resourceKey: item.resourceKey });
            }
          }
          pageToken = str(page.nextPageToken);
        } while (pageToken);
      }
      return items;
    },

    async fetchFile(fileId, opts = {}) {
      const maxBytes = opts.maxBytes ?? MAX_GOOGLE_FILE_BYTES;
      const raw = await resolve(fileId, opts.resourceKey);
      const plan = downloadPlan(raw.mimeType, opts.sheetsAs);
      if (plan.action === "folder" || plan.action === "unsupported") throw new DriveUnreadableError("unsupported");
      const data = plan.action === "export"
        ? await exportBytes(raw, plan.mimeType, maxBytes)
        : await download(raw, maxBytes);
      const file: DriveFile = {
        id: raw.id,
        name: raw.name,
        mimeType: raw.mimeType,
        modifiedTime: raw.modifiedTime ?? "",
        data,
        fileName: downloadName(raw.name, plan),
      };
      if (plan.action === "export") file.exportedAs = plan.mimeType;
      return file;
    },

    async fetchPdf(fileId, opts = {}) {
      const maxBytes = opts.maxBytes ?? MAX_GOOGLE_FILE_BYTES;
      const raw = await resolve(fileId, opts.resourceKey);
      let bytes: Uint8Array;
      if (raw.mimeType === PDF_MIME) bytes = await download(raw, maxBytes);
      else if (raw.mimeType === GOOGLE_SLIDES_MIME || raw.mimeType === GOOGLE_DOC_MIME) {
        bytes = await exportBytes(raw, PDF_MIME, maxBytes);
      } else throw new DriveUnreadableError("unsupported");
      if (!looksLikePdf(bytes)) throw new DriveUnreadableError("unsupported");
      return { bytes, meta: toFileMeta(raw) };
    },
  };
}

function isDocsExportLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname === "docs.google.com";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wiring pieces for drive-grant.ts, kept pure so Node tests cover them.
// ---------------------------------------------------------------------------

export interface GrantTokenDeps {
  fetch: FetchLike;
  credentials: ClientCredentials;
  /** The stored refresh token, decrypted on demand. */
  refreshToken(): Promise<string>;
  /** The cached access token from the store, if one was saved. */
  cached?: { expiresAt: string | null; accessToken(): Promise<string> } | null;
  /** Persists a refreshed access token (best effort; failures are the caller's to log). */
  save(grant: TokenGrant, expiresAt: string): Promise<void>;
  /** Google says the grant is gone (revoked, or a Testing-status grant past 7 days): forget it. */
  drop(): Promise<void>;
  now?: () => Date;
}

/**
 * An AccessTokenSource for a stored grant: uses the cached access token while
 * it has a minute left, otherwise refreshes (one refresh in flight at a time)
 * and saves the new token. `forceRefresh` (after a 401) always refreshes. A
 * dead grant is dropped and surfaces as DriveAuthError.
 */
export function grantTokenSource(deps: GrantTokenDeps): (opts: { forceRefresh: boolean }) => Promise<string> {
  const now = deps.now ?? (() => new Date());
  let current: { token: string; expiresAt: string } | null = null;
  let storedCache = deps.cached ?? null;
  let inFlight: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    let grant: TokenGrant;
    try {
      grant = await refreshAccessToken(deps.fetch, deps.credentials, await deps.refreshToken());
    } catch (error) {
      if (error instanceof DriveAuthError) await deps.drop();
      throw error;
    }
    const expiresAt = new Date(now().getTime() + grant.expiresIn * 1000).toISOString();
    current = { token: grant.accessToken, expiresAt };
    await deps.save(grant, expiresAt);
    return grant.accessToken;
  }

  return async ({ forceRefresh }) => {
    if (!forceRefresh) {
      if (current && accessTokenFresh(current.expiresAt, now())) return current.token;
      if (!current && storedCache && accessTokenFresh(storedCache.expiresAt, now())) {
        const token = await storedCache.accessToken();
        current = { token, expiresAt: storedCache.expiresAt! };
        return token;
      }
    }
    storedCache = null;
    inFlight ??= refresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

export interface DriveAuditSink {
  /** Inserts a "started" row and returns its id, or null when it couldn't be written. */
  start(entry: { action: "read" | "search"; fileId: string }): Promise<number | null>;
  finish(
    id: number,
    result: { outcome: DriveAuditOutcome; driveStatus: number | null; mimeType: string | null; bytes: number | null },
  ): Promise<void>;
}

/**
 * Wraps a client so every file read (fetchFile, fetchPdf) and folder listing
 * writes a google_drive_audit row first. If the row can't be written the read
 * doesn't happen (fails closed, retryable). stat() reads metadata only and
 * isn't audited.
 */
export function auditDriveClient(base: DriveClient, sink: DriveAuditSink): DriveClient {
  async function audited<T>(
    action: "read" | "search",
    fileId: string,
    run: () => Promise<T>,
    describe: (value: T) => { mimeType: string | null; bytes: number | null },
  ): Promise<T> {
    // google_drive_audit.file_id only takes Drive ids; anything else can't be one.
    if (!isDriveId(fileId)) throw new DriveNotFoundError("drive: not a Drive id");
    const id = await sink.start({ action, fileId });
    if (id === null) throw new DriveTransientError("drive audit unavailable");
    try {
      const value = await run();
      await sink.finish(id, { outcome: "ok", driveStatus: 200, ...describe(value) });
      return value;
    } catch (error) {
      await sink.finish(id, { ...auditOutcomeFor(error), mimeType: null, bytes: null });
      throw error;
    }
  }

  return {
    stat: (id, opts) => base.stat(id, opts),
    listFolder: (folderId, opts) =>
      audited("search", folderId, () => base.listFolder(folderId, opts), () => ({ mimeType: GOOGLE_FOLDER_MIME, bytes: null })),
    fetchFile: (fileId, opts) =>
      audited("read", fileId, () => base.fetchFile(fileId, opts), (file) => ({
        mimeType: file.mimeType,
        bytes: file.data.byteLength,
      })),
    fetchPdf: (fileId, opts) =>
      audited("read", fileId, () => base.fetchPdf(fileId, opts), (pdf) => ({
        mimeType: pdf.meta.mimeType,
        bytes: pdf.bytes.byteLength,
      })),
  };
}
