import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { readHandoffTokenHash } from "../src/lib/auth/handoff.ts";

test("a hex sign-in token is read as is", () => {
  const hash = "4f2c9a0e8b7d6c5a4f2c9a0e8b7d6c5a4f2c9a0e8b7d6c5a4f2c9a0e";
  assert.equal(readHandoffTokenHash(hash), hash);
});

test("anything that isn't a token is dropped before it reaches Supabase", () => {
  for (const raw of [
    null,
    undefined,
    "",
    "short",
    "a".repeat(257),
    "4f2c9a0e8b7d6c5a 4f2c9a0e",
    "4f2c9a0e8b7d6c5a%00",
    "../../../../etc/passwd",
    "<script>alert(1)</script>",
  ]) {
    assert.equal(readHandoffTokenHash(raw), null, String(raw));
  }
});

// The route itself needs Next and Supabase at runtime; these pin the parts
// that keep the token safe and the redirect on Polya.
test("the handoff route redeems the token once and only redirects to a sanitized path", () => {
  const source = readFileSync(new URL("../src/app/auth/handoff/route.ts", import.meta.url), "utf8");
  assert.match(source, /sanitizeNextPath\(request\.nextUrl\.searchParams\.get\("next"\)\)/);
  assert.match(source, /verifyOtp\(\{ token_hash: tokenHash, type: "email" \}\)/);
  assert.match(source, /"Cache-Control", "no-store"/);
  assert.match(source, /"Referrer-Policy", "no-referrer"/);
  assert.doesNotMatch(source, /console\.\w+\([^)]*tokenHash/, "the token is never logged");
});
