import { test } from "node:test";
import assert from "node:assert/strict";

import { decryptToken, encryptToken } from "../supabase/functions/_shared/token-crypto.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

test("token round-trips through encrypt/decrypt", async () => {
  const token = "1016~abcDEFghi123";
  const payload = await encryptToken(token, KEY);
  assert.notEqual(payload, token);
  assert.equal(await decryptToken(payload, KEY), token);
});

test("each encryption uses a fresh IV", async () => {
  const token = "same-token";
  const a = await encryptToken(token, KEY);
  const b = await encryptToken(token, KEY);
  assert.notEqual(a, b);
  assert.equal(await decryptToken(a, KEY), token);
  assert.equal(await decryptToken(b, KEY), token);
});

test("decrypting with the wrong key fails", async () => {
  const payload = await encryptToken("secret", KEY);
  await assert.rejects(() => decryptToken(payload, OTHER_KEY));
});

test("tampered ciphertext fails authentication", async () => {
  const payload = await encryptToken("secret", KEY);
  const bytes = Buffer.from(payload, "base64");
  bytes[bytes.length - 1] ^= 0xff;
  await assert.rejects(() => decryptToken(bytes.toString("base64"), KEY));
});

test("malformed keys and payloads are rejected", async () => {
  await assert.rejects(() => encryptToken("secret", "tooshort"));
  await assert.rejects(() => decryptToken("AAAA", KEY)); // shorter than one IV
});
