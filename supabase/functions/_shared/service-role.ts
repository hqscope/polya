// Constant-time checks for the secrets polya-import's background worker
// accepts: the service-role key its own self-invoke chain sends, and the pump
// secret the pg_cron sweeper sends (Phase 9 A-9; the old check used `===`,
// which returns as soon as a byte differs).
//
// Same approach as lectra-ios/backend/functions/_shared/service-role.ts's
// isServiceRoleKey: hash both sides with SHA-256, then compare the equal-length
// digests without an early exit, so neither the timing nor the length of the
// expected secret leaks. A missing expected secret fails closed.
//
// Pure module (Web Crypto only, no Deno globals) so Node's test runner can
// import it too.

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Equality of two hex strings that doesn't stop at the first difference. */
export function secureHexEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/** True only when `presented` equals `expected`. Surrounding whitespace is
 * ignored; an empty value on either side is a no. */
export async function secretMatches(
  presented: string | null | undefined,
  expected: string | null | undefined,
): Promise<boolean> {
  const presentedValue = (presented ?? "").trim();
  const expectedValue = (expected ?? "").trim();
  if (!presentedValue || !expectedValue) return false;
  const [presentedHash, expectedHash] = await Promise.all([
    sha256Hex(presentedValue),
    sha256Hex(expectedValue),
  ]);
  return secureHexEqual(presentedHash, expectedHash);
}

/** The bearer from an `Authorization` header, or "" when there is none. */
export function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization") ?? "";
  return authorization.replace(/^Bearer\s+/i, "").trim();
}
