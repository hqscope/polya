import { test } from "node:test";
import assert from "node:assert/strict";

import { isRetryableWriteError, withWriteRetry, WRITE_RETRIES } from "../src/lib/write-retry.ts";

function functionError(code: string): Error & { code: string; status: number } {
  return Object.assign(new Error("Writing questions took longer than expected. Please try again."), {
    name: "FunctionError",
    code,
    status: 503,
  });
}

const noSleep = async () => {};

test("only slow and unavailable function errors are retryable", () => {
  assert.equal(isRetryableWriteError(functionError("slow")), true);
  assert.equal(isRetryableWriteError(functionError("unavailable")), true);
  for (const code of ["rate_limited", "busy", "conflict", "internal", "bad_request"]) {
    assert.equal(isRetryableWriteError(functionError(code)), false, code);
  }
  assert.equal(isRetryableWriteError(new TypeError("Failed to fetch")), false);
  assert.equal(isRetryableWriteError(null), false);
});

test("a slow step is asked again and its result returned", async () => {
  let calls = 0;
  const result = await withWriteRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw functionError("slow");
      return "ready";
    },
    { sleep: noSleep },
  );
  assert.equal(result, "ready");
  assert.equal(calls, 2);
});

test("gives up after the retries and throws the last error", async () => {
  let calls = 0;
  await assert.rejects(
    withWriteRetry(
      async () => {
        calls += 1;
        throw functionError("slow");
      },
      { sleep: noSleep },
    ),
    (err: unknown) => (err as { code?: string }).code === "slow",
  );
  assert.equal(calls, WRITE_RETRIES + 1);
});

test("other errors surface at once, without a retry", async () => {
  let calls = 0;
  await assert.rejects(
    withWriteRetry(
      async () => {
        calls += 1;
        throw functionError("rate_limited");
      },
      { sleep: noSleep },
    ),
  );
  assert.equal(calls, 1);
});

test("waits between tries", async () => {
  const waits: number[] = [];
  let calls = 0;
  await withWriteRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw functionError("unavailable");
      return calls;
    },
    { pauseMs: 1_500, sleep: async (ms) => void waits.push(ms) },
  );
  assert.deepEqual(waits, [1_500, 1_500]);
});
