// Where to send someone after they sign in (P-37). The path travels through
// /login, /auth/login and the OAuth callback as `?next=`, so it's attacker-
// controlled at every hop and is re-checked at each one.
//
// No imports on purpose: Node's test runner loads this file directly.

export const DEFAULT_NEXT_PATH = "/app";

/**
 * Request header `src/proxy.ts` sets on /app requests so the app layout (which
 * can't see the URL) knows which page was asked for. Always overwritten by the
 * proxy, and sanitized again where it's read.
 */
export const NEXT_PATH_HEADER = "x-polya-next-path";

// Only places inside the signed-in app are valid destinations.
const ALLOWED_PREFIXES = ["/app"];

const MAX_LENGTH = 2048;

// Any origin works as a parsing base; only whether the result stays on it matters.
const PARSE_BASE = "https://next-path.invalid";

/**
 * Returns a same-origin path under an allowed prefix, or `/app`.
 *
 * Accepts only a path that starts with a single `/` (not `//`, no scheme),
 * with no backslashes, whitespace or control characters (browsers drop tabs
 * and newlines and read `\` as `/`, which can turn `/\evil.com` into
 * `//evil.com`). The path is then resolved against a dummy origin: it must
 * stay on that origin, and its resolved pathname (after `..` and `%2e%2e`
 * are applied) must be `/app` or under `/app/`. The resolved form is what's
 * returned, so what gets checked is what gets used.
 */
export function sanitizeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LENGTH) {
    return DEFAULT_NEXT_PATH;
  }
  if (!raw.startsWith("/") || raw.startsWith("//")) {
    return DEFAULT_NEXT_PATH;
  }
  // Backslashes, whitespace and C0/DEL control characters.
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) {
    return DEFAULT_NEXT_PATH;
  }

  let resolved: URL;
  try {
    resolved = new URL(raw, PARSE_BASE);
  } catch {
    return DEFAULT_NEXT_PATH;
  }
  if (resolved.origin !== PARSE_BASE) {
    return DEFAULT_NEXT_PATH;
  }

  const { pathname, search } = resolved;
  const allowed = ALLOWED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  // The prefix check already rules out a resolved path starting with `//`
  // (`/a/..//evil.com`); the explicit check keeps that true if a prefix changes.
  if (!allowed || pathname.startsWith("//")) {
    return DEFAULT_NEXT_PATH;
  }

  return `${pathname}${search}`;
}

/** The sign-in page URL that returns to `nextPath` (sanitized) afterwards. */
export function loginPathFor(nextPath: string | null | undefined): string {
  return `/login?next=${encodeURIComponent(sanitizeNextPath(nextPath))}`;
}
