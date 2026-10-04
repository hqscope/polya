// Phase 9 A-9: the constant-time secret compare polya-import's pump uses.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { bearerToken, secretMatches, secureHexEqual, sha256Hex } from "./service-role.ts";

const SECRET = "3f9c2e7a-pump-secret-value";

Deno.test("the exact secret matches; surrounding whitespace is ignored", async () => {
  assert(await secretMatches(SECRET, SECRET));
  assert(await secretMatches(`  ${SECRET}\n`, SECRET));
});

Deno.test("near misses do not match", async () => {
  assert(!(await secretMatches(SECRET.slice(0, -1), SECRET)), "a prefix");
  assert(!(await secretMatches(`${SECRET}x`, SECRET)), "a longer string");
  assert(!(await secretMatches(SECRET.toUpperCase(), SECRET)), "different case");
  assert(!(await secretMatches("something-else", SECRET)), "a different value");
});

Deno.test("missing values fail closed", async () => {
  assert(!(await secretMatches("", SECRET)));
  assert(!(await secretMatches(null, SECRET)));
  assert(!(await secretMatches(undefined, SECRET)));
  assert(!(await secretMatches(SECRET, "")), "an unset expected secret must not match everything");
  assert(!(await secretMatches(SECRET, undefined)));
  assert(!(await secretMatches("", "")), "two empties must not match");
  assert(!(await secretMatches("   ", "   ")), "whitespace-only is empty");
});

Deno.test("secureHexEqual compares every position and refuses length mismatches", () => {
  assert(secureHexEqual("abcd", "abcd"));
  assert(!secureHexEqual("abcd", "abce"));
  assert(!secureHexEqual("abcd", "bbcd"));
  assert(!secureHexEqual("abcd", "abcde"));
  assert(!secureHexEqual("", ""));
});

Deno.test("the compare runs over fixed-length digests, whatever the input length", async () => {
  const short = await sha256Hex("a");
  const long = await sha256Hex("a".repeat(10_000));
  assertEquals(short.length, 64);
  assertEquals(long.length, 64);
  assert(/^[0-9a-f]{64}$/.test(short));
});

Deno.test("the compare has no early exit (source check)", async () => {
  // A plain `===` or an early `return` inside the loop would reintroduce the
  // timing leak A-9 fixed. Keep this in step with the implementation.
  const source = await Deno.readTextFile(new URL("./service-role.ts", import.meta.url));
  const loop = source.slice(source.indexOf("for (let index"), source.indexOf("return difference === 0"));
  assert(loop.includes("difference |="), "accumulates differences");
  assert(!loop.includes("return"), "no return inside the loop");
});

Deno.test("bearerToken strips the scheme and nothing else", () => {
  const request = (value?: string) =>
    new Request("https://example.invalid", { headers: value ? { Authorization: value } : {} });
  assertEquals(bearerToken(request(`Bearer ${SECRET}`)), SECRET);
  assertEquals(bearerToken(request(`bearer ${SECRET}`)), SECRET);
  assertEquals(bearerToken(request()), "");
});
