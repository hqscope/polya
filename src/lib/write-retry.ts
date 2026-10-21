// Writing practice questions is the slowest thing Polya does: one request
// writes a batch, then an independent solve checks it. Once in a while the
// writing runs past its time limit and polya-study answers `slow` (or
// `unavailable` for a passing model hiccup) before saving anything new. Asking
// again is safe — a mock exam keeps the questions it already has — so the
// browser retries those two codes a couple of times before showing the error.
// Every other code (daily limit, busy, conflict) surfaces at once.
//
// Pure and dependency-free so `tests/` can import it under Node's test runner.
// `FunctionError` is duck-typed for the same reason as in `user-message.ts`.

const RETRY_CODES = new Set(["slow", "unavailable"]);

export const WRITE_RETRIES = 2;
export const WRITE_RETRY_PAUSE_MS = 2_000;

export function isRetryableWriteError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === "FunctionError" && typeof e.code === "string" && RETRY_CODES.has(e.code);
}

/** Runs `call`, asking again up to `retries` times when it fails with a retryable write error. */
export async function withWriteRetry<T>(
  call: () => Promise<T>,
  options: { retries?: number; pauseMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const { retries = WRITE_RETRIES, pauseMs = WRITE_RETRY_PAUSE_MS, sleep = pause } = options;
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= retries || !isRetryableWriteError(err)) throw err;
      await sleep(pauseMs);
    }
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
