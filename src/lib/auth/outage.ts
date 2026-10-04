import type { AuthError } from "@supabase/supabase-js";

// GoTrue rejects a dead session with 400 (refresh token gone or reused), 401,
// or 403 (bad or orphaned access token), always with an error code. Same set
// as the Scope extension's refresh guard (auth-session-guard.js).
const SIGN_OUT_STATUSES = new Set([400, 401, 403]);

/**
 * A failed `getUser()`/`getSession()` call during a Supabase outage (5xx, a
 * 402 over quota, a 429, a network failure, or a retryable fetch error) is
 * not proof the session itself is invalid. Only treat the user as signed out
 * when there was no session to begin with (`AuthSessionMissingError`, which
 * auth-js returns without making a request), or when GoTrue itself says so:
 * a 400/401/403 with an auth-specific error code (e.g. `refresh_token_not_found`,
 * `bad_jwt`, `session_not_found`). Anything else means we couldn't confirm the
 * session either way, and callers must show a retry notice instead of routing
 * to sign-in or clearing cookies.
 */
export function isDefiniteSignOut(error: AuthError | null | undefined): boolean {
  if (!error) return false;
  if (error.name === "AuthSessionMissingError") return true;
  return (
    typeof error.status === "number" &&
    SIGN_OUT_STATUSES.has(error.status) &&
    typeof error.code === "string" &&
    error.code.length > 0
  );
}

/** True when `error` is present but we can't tell if the session is actually invalid. */
export function isAuthOutage(error: AuthError | null | undefined): boolean {
  return Boolean(error) && !isDefiniteSignOut(error);
}
