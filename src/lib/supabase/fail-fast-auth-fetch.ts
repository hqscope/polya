// P-36: during an auth outage, a server render with an *expired* session
// waited ~26 s before the outage notice. auth-js retries a session refresh
// that fails with a 5xx (`NETWORK_ERROR_CODES` in auth-js lib/fetch.js:
// 502-504 in 2.99; 500-504 and 520-530 in 2.110) or with no response,
// sleeping 200 ms x 2^n between attempts for up to 30 s
// (`_refreshAccessToken` -> `retryable`), and the render awaits all of it. A
// 402 isn't retried, which is why the quota outage itself was fast.
//
// This wrapper is passed as the server client's `global.fetch`. It only
// touches two auth calls and passes everything else (data queries, other auth
// calls) through unchanged:
//
// - `POST /auth/v1/token?grant_type=refresh_token`: bounded by a timeout, and
//   a 5xx, a thrown fetch or a timeout comes back as a single non-retryable
//   `408 auth_unreachable` answer. auth-js then fails at once with an
//   `AuthApiError` (status 408), which `isAuthOutage` classes as an outage:
//   no sign-out, no redirect to /login. Real GoTrue answers (a 400/401/403
//   rejection with a code, a 402, a 429, a success) are returned untouched.
// - `GET /auth/v1/user`: bounded by the same timeout. auth-js doesn't retry
//   it; a timeout surfaces as a retryable fetch error with no status, which is
//   also an outage.
//
// Known consequence, same as a 402 refresh today: when the refresh fails with
// a non-retryable error, auth-js removes the session from its storage (2.110
// only does so once the access token has expired). Server Components can't write
// cookies (the write throws and `setAll` swallows it), and scope-web's proxy
// forwards the original cookies on an outage, so the browser keeps its
// session. Don't pass this fetch to a client whose `setAll` really writes
// cookies (route handlers, Server Actions).
//
// No imports on purpose: Node's test runner loads this file directly.

/** Per-call budget for the refresh and user lookups (the extension uses 2.5 s too). */
export const AUTH_CALL_TIMEOUT_MS = 2500;

/** Error code carried by the synthetic answer, so logs can tell it apart. */
export const AUTH_UNREACHABLE_CODE = "auth_unreachable";

// Not in auth-js's retried set, and not one of the sign-out statuses
// (400/401/403) that `isDefiniteSignOut` accepts.
const UNREACHABLE_STATUS = 408;

// `new Response()` rejects a body for these.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type AuthCall = "refresh" | "user" | "other";

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    return new URL(input.url);
  } catch {
    return null;
  }
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === "object" && !(input instanceof URL) && input.method) {
    return input.method.toUpperCase();
  }
  return "GET";
}

export function classifyAuthCall(input: RequestInfo | URL, init?: RequestInit): AuthCall {
  const url = requestUrl(input);
  if (!url) return "other";
  const method = requestMethod(input, init);
  const path = url.pathname.replace(/\/+$/, "");
  if (
    method === "POST" &&
    path.endsWith("/auth/v1/token") &&
    url.searchParams.get("grant_type") === "refresh_token"
  ) {
    return "refresh";
  }
  if (method === "GET" && path.endsWith("/auth/v1/user")) {
    return "user";
  }
  return "other";
}

function unreachableResponse(): Response {
  return new Response(
    JSON.stringify({
      error_code: AUTH_UNREACHABLE_CODE,
      msg: "The sign-in service didn't answer in time.",
    }),
    {
      status: UNREACHABLE_STATUS,
      headers: { "content-type": "application/json" },
    },
  );
}

function withTimeout(init: RequestInit | undefined, timeoutMs: number): RequestInit {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return { ...init, signal };
}

export function createFailFastAuthFetch(
  baseFetch: FetchLike = (input, init) => fetch(input, init),
  timeoutMs: number = AUTH_CALL_TIMEOUT_MS,
): typeof fetch {
  const failFast: FetchLike = async (input, init) => {
    const call = classifyAuthCall(input, init);
    if (call === "other") return baseFetch(input, init);

    if (call === "user") return baseFetch(input, withTimeout(init, timeoutMs));

    try {
      const response = await baseFetch(input, withTimeout(init, timeoutMs));
      if (response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        return unreachableResponse();
      }
      // Read the body inside the same time budget: a body that stalls after
      // the headers would otherwise fail later in auth-js as a retryable error.
      const body = NULL_BODY_STATUSES.has(response.status)
        ? null
        : await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      // The caller's own abort isn't an outage; let it through as before.
      if (init?.signal?.aborted) throw error;
      return unreachableResponse();
    }
  };
  return failFast as typeof fetch;
}
