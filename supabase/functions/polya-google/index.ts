// polya-google — the student's Google Drive connection for Polya.
// Actions (POST JSON `{ action, ... }`, user JWT required):
//   status      {}                                     access, config, connection (never tokens)
//   connect     { code, code_verifier, redirect_uri }  server-side code exchange; the grant is
//                                                      stored encrypted, never returned
//   disconnect  {}                                     revoke at Google, delete the grant
//
// The web flow: ConnectGoogleDrive → /auth/google-drive/start (asks `status`
// for the client id, sets a PKCE + state cookie, redirects to Google) →
// Google → /auth/google-drive/callback (checks state, posts the code here).
// The client secret, the token key and the tokens stay in this function.
//
// The grant is the platform's google_tokens 'drive' row, shared with the
// Scope extension (see _shared/drive-connection.ts). Connect is gated by the
// google_drive_full_read flag (Google test users only until verification).
import { corsHeaders, json } from "../_shared/cors.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";
import { service } from "../_shared/service.ts";
import { readJsonCapped } from "../_shared/read-json-capped.ts";
import { claimRateLimit, rateLimitedResponse } from "../_shared/rate-limit.ts";
import { HOUR_SECONDS } from "../_shared/polya-rate-limits.ts";
import {
  DRIVE_READONLY_SCOPE,
  DriveAuthError,
  DriveSetupError,
  DriveTransientError,
  exchangeCode,
  GRANT_SCOPES,
  isConnectRedirectUri,
  revokeToken,
  type TokenGrant,
} from "../_shared/drive.ts";
import {
  driveAccessFor,
  driveConfigured,
  driveCredentials,
  loadGrantSummary,
  removeGrant,
  saveGrant,
} from "../_shared/drive-connection.ts";

const MAX_BODY_BYTES = 8 * 1024;
const HOURLY_LIMIT = 120;
const HOURLY_BUCKET = "polya-google:hour";
const CONNECT_LIMIT = 10;
const CONNECT_BUCKET = "polya-google:connect:hour";

// RFC 7636 code_verifier, and an authorization code (printable ASCII).
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const CODE_RE = /^[\x21-\x7e]{10,2048}$/;

// Student-facing. The web callback maps `code` to its own message; these are
// what other callers (and logs of failed connects) see.
const COPY = {
  comingSoon: "Google Drive isn't available for your account yet.",
  unavailable: "Couldn't reach Google right now. Try again in a moment.",
  denied: "Polya needs permission to see your Google Drive files. Connect again and allow it.",
  retry: "That Google sign-in didn't go through. Try connecting again.",
  badRequest: "Invalid request.",
  limited: "Too many tries. Wait a little and try again.",
  internal: "Something went wrong connecting Google Drive.",
} as const;

type Body = { action?: unknown; code?: unknown; code_verifier?: unknown; redirect_uri?: unknown };

function fail(status: number, code: string, error: string): Response {
  return json({ error, code }, status);
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return fail(405, "method_not_allowed", "Method not allowed");
  }

  const parsed = await readJsonCapped<Body>(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return parsed.status === 413
      ? fail(413, "too_large", "That request is too large.")
      : fail(400, "bad_request", COPY.badRequest);
  }
  const body = parsed.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(400, "bad_request", COPY.badRequest);
  }

  try {
    const user = await requireAuthUser(request);
    if (!(await claimRateLimit(service, `user:${user.id}`, HOURLY_BUCKET, HOURLY_LIMIT, HOUR_SECONDS))) {
      return rateLimitedResponse({ message: COPY.limited, headers: corsHeaders });
    }

    switch (body.action) {
      case "status":
        return await handleStatus(user.id);
      case "connect":
        return await handleConnect(user.id, body);
      case "disconnect":
        return await handleDisconnect(user.id);
      default:
        return fail(400, "bad_request", "Unknown action");
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return fail(error.status, "unauthorized", error.message);
    }
    // Errors from drive.ts / drive-connection.ts never carry token values.
    console.error("[polya-google] error:", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return fail(500, "internal", COPY.internal);
  }
});

async function handleStatus(userId: string): Promise<Response> {
  const access = await driveAccessFor(userId);
  const configured = driveConfigured();
  const grant = await loadGrantSummary(userId);
  return json({
    access,
    configured,
    connected: grant?.usable === true,
    email: grant?.usable ? grant.email : null,
    // The client id is public; it's only handed out when a connect can work.
    client_id: access === "full" && configured ? driveCredentials()?.clientId ?? null : null,
    scopes: access === "full" ? [...GRANT_SCOPES] : [],
  });
}

async function handleConnect(userId: string, body: Body): Promise<Response> {
  const code = typeof body.code === "string" ? body.code : "";
  const codeVerifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
  const redirectUri = body.redirect_uri;
  if (!CODE_RE.test(code) || !VERIFIER_RE.test(codeVerifier) || !isConnectRedirectUri(redirectUri)) {
    return fail(400, "bad_request", COPY.badRequest);
  }
  if ((await driveAccessFor(userId)) !== "full") return fail(403, "coming_soon", COPY.comingSoon);
  const credentials = driveCredentials();
  if (!credentials || !driveConfigured()) return fail(503, "not_configured", COPY.comingSoon);
  if (!(await claimRateLimit(service, `user:${userId}`, CONNECT_BUCKET, CONNECT_LIMIT, HOUR_SECONDS))) {
    return rateLimitedResponse({ message: COPY.limited, headers: corsHeaders });
  }

  let grant: TokenGrant;
  try {
    grant = await exchangeCode(fetch, credentials, { code, codeVerifier, redirectUri });
  } catch (error) {
    // An expired or reused code, or a verifier that doesn't match: start over.
    if (error instanceof DriveAuthError) return fail(400, "retry", COPY.retry);
    if (error instanceof DriveSetupError) {
      console.error("[polya-google] connect: Google rejected the Drive OAuth client");
      return fail(503, "not_configured", COPY.unavailable);
    }
    if (error instanceof DriveTransientError) return fail(502, "unavailable", COPY.unavailable);
    throw error;
  }

  // Google's consent screen lets people untick Drive. Without it there's nothing to keep.
  if (!grant.scopes.includes(DRIVE_READONLY_SCOPE)) {
    await revokeToken(fetch, grant.refreshToken ?? grant.accessToken);
    return fail(400, "denied", COPY.denied);
  }
  // access_type=offline + prompt=consent always returns one; don't keep a
  // grant that can't outlive the hour.
  if (!grant.refreshToken) {
    console.error("[polya-google] connect: no refresh token in the exchange");
    await revokeToken(fetch, grant.accessToken);
    return fail(502, "retry", COPY.retry);
  }

  await saveGrant(userId, { ...grant, refreshToken: grant.refreshToken });
  return json({ connected: true, email: grant.email });
}

async function handleDisconnect(userId: string): Promise<Response> {
  const { removed } = await removeGrant(userId);
  return json({ ok: true, removed });
}
