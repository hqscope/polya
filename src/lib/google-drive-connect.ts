// Connecting a student's Google Drive (read-only) from the web app, so Polya
// can bring in course files shared only with their school's Google accounts.
//
//   ConnectGoogleDrive → GET /auth/google-drive/start
//     asks polya-google `status` for the client id, sets the flow cookie
//     (state + PKCE verifier + where to return), redirects to Google
//   → Google consent → GET /auth/google-drive/callback
//     checks state against the cookie, posts code + verifier to polya-google
//     `connect` (the code exchange and the grant stay server-side)
//   → back to the page with ?drive=<result>
//
// Pure and import-free so tests/ can load it under Node's test runner (like
// next-path.ts). WebCrypto only: runs in Node, the browser, and edge runtimes.

export const DRIVE_START_PATH = "/auth/google-drive/start";
/** Must match CONNECT_CALLBACK_PATH in supabase/functions/_shared/drive.ts. */
export const DRIVE_CALLBACK_PATH = "/auth/google-drive/callback";
export const DRIVE_FLOW_COOKIE = "polya_drive_connect";
/** The cookie is sent only to the two routes above. */
export const DRIVE_FLOW_COOKIE_PATH = "/auth/google-drive";
/** Ten minutes to finish Google's consent screen. */
export const DRIVE_FLOW_MAX_AGE_SECONDS = 600;
/** Query parameter the callback adds to the return path. */
export const DRIVE_RESULT_PARAM = "drive";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export type DriveConnectResult = "connected" | "denied" | "unavailable" | "error";
const RESULTS: ReadonlySet<string> = new Set(["connected", "denied", "unavailable", "error"]);

/** What polya-google `status` answers. */
export interface DriveStatus {
  access: "full" | "coming_soon";
  configured: boolean;
  connected: boolean;
  email: string | null;
  client_id: string | null;
  scopes: string[];
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `byteLength` random bytes as base64url (32 bytes → 43 characters). */
export function randomUrlSafe(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** RFC 7636 S256 code challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomUrlSafe(32);
  return { verifier, challenge: await pkceChallenge(verifier) };
}

/**
 * Google's consent URL. Offline access + consent prompt so Google returns a
 * refresh token every time; include_granted_scopes matches the extension's
 * request on the same client.
 */
export function buildDriveAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  codeChallenge: string;
  state: string;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: input.scopes.join(" "),
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    state: input.state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  }).toString();
  return url.toString();
}

/** What the start route remembers for the callback, in an httpOnly cookie. */
export interface DriveFlow {
  state: string;
  verifier: string;
  /** Sanitized return path. */
  next: string;
  /** The Polya user who started the connect; the callback must be the same user. */
  uid: string;
}

const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const UID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function encodeDriveFlow(flow: DriveFlow): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(flow)));
}

/** The flow cookie's contents, or null when it's missing or not ours. */
export function decodeDriveFlow(raw: string | null | undefined): DriveFlow | null {
  if (!raw || raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(raw.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Record<keyof DriveFlow, unknown>>;
    const { state, verifier, next, uid } = value;
    if (typeof state !== "string" || !STATE_RE.test(state)) return null;
    if (typeof verifier !== "string" || !VERIFIER_RE.test(verifier)) return null;
    if (typeof next !== "string" || !next.startsWith("/") || next.length > 2048) return null;
    if (typeof uid !== "string" || !UID_RE.test(uid)) return null;
    return { state, verifier, next, uid };
  } catch {
    return null;
  }
}

/** Reads Google's redirect: the code to exchange, or the result to show. */
export function readDriveCallback(
  params: URLSearchParams,
  expectedState: string,
): { ok: true; code: string } | { ok: false; result: DriveConnectResult } {
  const error = params.get("error");
  if (error) return { ok: false, result: error === "access_denied" ? "denied" : "error" };
  const state = params.get("state");
  if (!state || state !== expectedState) return { ok: false, result: "error" };
  const code = params.get("code");
  if (!code) return { ok: false, result: "error" };
  return { ok: true, code };
}

/** polya-google `connect`'s answer as the result the page shows. */
export function connectResultFor(status: number, code: unknown): DriveConnectResult {
  if (status >= 200 && status < 300) return "connected";
  if (code === "denied") return "denied";
  if (code === "coming_soon" || code === "not_configured") return "unavailable";
  return "error";
}

const PARSE_BASE = "https://drive-connect.invalid";

/** `nextPath` with `?drive=<result>` set (any earlier result replaced). */
export function withDriveResult(nextPath: string, result: DriveConnectResult): string {
  const url = new URL(nextPath, PARSE_BASE);
  url.searchParams.set(DRIVE_RESULT_PARAM, result);
  return `${url.pathname}${url.search}`;
}

/** The start route's address, returning to `currentPath` (an earlier `?drive=` result dropped). */
export function driveStartHref(currentPath: string): string {
  const url = new URL(currentPath, PARSE_BASE);
  url.searchParams.delete(DRIVE_RESULT_PARAM);
  return `${DRIVE_START_PATH}?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`;
}

/** The `?drive=` result in a query string, if it's one of ours. */
export function readDriveResult(search: string): DriveConnectResult | null {
  const value = new URLSearchParams(search).get(DRIVE_RESULT_PARAM);
  return value && RESULTS.has(value) ? (value as DriveConnectResult) : null;
}
