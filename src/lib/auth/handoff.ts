// "Open in Polya" from the Scope extension signs the student in on arrival:
// the extension gets a one-time sign-in token from polya-handoff and opens
// `/auth/handoff?token_hash=…&next=…`. The token is whatever the browser sent,
// so it's checked for shape before it reaches Supabase.
//
// No imports on purpose: Node's test runner loads this file directly.

// GoTrue's hashed_token is hex today. URL-safe characters and a generous
// length leave room for a format change to fail at verifyOtp instead of here.
const TOKEN_HASH_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

/** The handoff token from the query string, or null if it isn't one. */
export function readHandoffTokenHash(raw: string | null | undefined): string | null {
  return typeof raw === "string" && TOKEN_HASH_PATTERN.test(raw) ? raw : null;
}
