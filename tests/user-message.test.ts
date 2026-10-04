import { test } from "node:test";
import assert from "node:assert/strict";

import {
  POLYA_ERROR_GENERIC,
  POLYA_ERROR_OFFLINE,
  POLYA_ERROR_SIGNED_OUT,
  userMessage,
} from "../src/lib/user-message.ts";

// Same shape as `FunctionError` in `@/lib/functions` (not imported: that module
// pulls in the Supabase browser client through a path alias Node can't resolve).
class FakeFunctionError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "FunctionError";
    this.code = code;
    this.status = status;
  }
}

test("a function's own message is shown as written", () => {
  const err = new FakeFunctionError(
    "Canvas didn't accept that access token. Double-check it and try again.",
    "canvas_auth",
    400,
  );
  assert.equal(userMessage(err, { offline: false }), err.message);
  assert.equal(
    userMessage(new FakeFunctionError("Couldn't start the import.", "internal", 500)),
    "Couldn't start the import.",
  );
});

test("a blank function message falls back to the fixed line", () => {
  assert.equal(userMessage(new FakeFunctionError("   ", "internal", 500)), POLYA_ERROR_GENERIC);
});

test("sign-in failures never show the auth layer's text", () => {
  // polya-canvas wraps auth errors as "Unauthorized: <raw reason>".
  const raw = new FakeFunctionError("Unauthorized: invalid JWT: token is malformed", "unauthorized", 401);
  assert.equal(userMessage(raw), POLYA_ERROR_SIGNED_OUT);
  assert.equal(userMessage(new FakeFunctionError("x", "signed_out", 401)), POLYA_ERROR_SIGNED_OUT);
  assert.equal(userMessage(new FakeFunctionError("x", "other", 401)), POLYA_ERROR_SIGNED_OUT);
});

test("anything that isn't a FunctionError is never shown raw", () => {
  const raws: unknown[] = [
    new TypeError("Failed to fetch"),
    new Error("new row violates row-level security policy for table \"polya_course_policies\""),
    { message: "The resource already exists", statusCode: "409" }, // a storage error object
    "boom",
    null,
    undefined,
    // Looks similar but isn't one: no code.
    Object.assign(new Error("secret detail"), { name: "FunctionError" }),
  ];
  for (const raw of raws) {
    assert.equal(userMessage(raw, { offline: false }), POLYA_ERROR_GENERIC);
    assert.equal(userMessage(raw, { offline: true }), POLYA_ERROR_OFFLINE);
  }
});

test("offline defaults to the browser's own flag", () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
    assert.equal(userMessage(new TypeError("Failed to fetch")), POLYA_ERROR_OFFLINE);
    Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
    assert.equal(userMessage(new TypeError("Failed to fetch")), POLYA_ERROR_GENERIC);
  } finally {
    if (nav) Object.defineProperty(globalThis, "navigator", nav);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("no fixed line names the machinery", () => {
  for (const line of [POLYA_ERROR_GENERIC, POLYA_ERROR_OFFLINE, POLYA_ERROR_SIGNED_OUT]) {
    assert.doesNotMatch(line, /server|database|token|supabase|function|fetch|policy|row/i);
  }
});
