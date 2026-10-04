// Turns a thrown error into the one line a student sees (POLISH P-13).
//
// A `FunctionError` carries text Polya's own functions wrote for the student
// ("Canvas didn't accept that access token…"), so it's shown as-is. Anything
// else (a failed fetch, a storage or database error, a bug) is never shown raw:
// it gets fixed copy, and the raw error stays in the console.
//
// Pure and dependency-free so `tests/` can import it under Node's test runner.
// `FunctionError` is duck-typed for the same reason as in `ai-busy.ts`.

// `polya.error.offline`
export const POLYA_ERROR_OFFLINE = "You're offline. Try again when you're connected.";
// `polya.error.generic`
export const POLYA_ERROR_GENERIC = "Something didn't go through. Try again in a moment.";
// `polya.error.signedOut` — also what `invokeFunction` shows when the
// session is gone.
export const POLYA_ERROR_SIGNED_OUT = "You've been signed out. Sign in again to keep going.";

const SIGNED_OUT_CODES = new Set(["signed_out", "unauthorized"]);

interface FunctionErrorLike {
  name: "FunctionError";
  message: string;
  code: string;
  status: number;
}

function isFunctionError(err: unknown): err is FunctionErrorLike {
  if (!err || typeof err !== "object") return false;
  const e = err as Partial<FunctionErrorLike>;
  return e.name === "FunctionError" && typeof e.message === "string" && typeof e.code === "string";
}

function browserIsOffline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return nav?.onLine === false;
}

export function userMessage(err: unknown, options: { offline?: boolean } = {}): string {
  if (isFunctionError(err)) {
    // A 401's text can come from the auth layer rather than from Polya.
    if (err.status === 401 || SIGNED_OUT_CODES.has(err.code)) return POLYA_ERROR_SIGNED_OUT;
    return err.message.trim() || POLYA_ERROR_GENERIC;
  }
  const offline = options.offline ?? browserIsOffline();
  return offline ? POLYA_ERROR_OFFLINE : POLYA_ERROR_GENERIC;
}
