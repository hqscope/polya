import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import {
  CLAIM_RPC,
  EMAIL_HANDLE_MARKER,
  IMESSAGE_LINK_PATH,
  PEEK_RPC,
  claimFailureFrom,
  imessageLinkPathFor,
  linkTargetFromPeek,
  parseLinkCode,
  phoneLastFour,
} from "../src/lib/imessage-link.ts";
import { loginPathFor, sanitizeNextPath } from "../src/lib/auth/next-path.ts";

const SITE = "https://askpolya.com";

test("a well-formed code is read from the URL", () => {
  assert.equal(parseLinkCode("Ab3_x-9Z"), "Ab3_x-9Z");
  assert.equal(parseLinkCode("  Ab3_x-9Z \n"), "Ab3_x-9Z");
  assert.equal(parseLinkCode("a".repeat(128)), "a".repeat(128));
});

test("a missing, repeated or malformed code is rejected", () => {
  for (const raw of [
    undefined,
    "",
    "   ",
    "abc12", // too short
    "a".repeat(129), // too long
    "abc def12",
    "abc%2F123",
    "abc/../123",
    "abc.123456",
    "<script>",
    "ab\u0000cdefg",
  ]) {
    assert.equal(parseLinkCode(raw), null, JSON.stringify(raw));
  }
  assert.equal(parseLinkCode(["Ab3_x-9Z", "Zz9_y-1A"]), null);
});

test("sign-in comes back to this page with the same code", () => {
  const code = "Ab3_x-9Z";
  const path = imessageLinkPathFor(code);
  assert.equal(path, "/connect/imessage?code=Ab3_x-9Z");
  assert.equal(sanitizeNextPath(path), path);

  // What /login reads back from the sign-in URL is the same path.
  const next = new URL(loginPathFor(path), SITE).searchParams.get("next");
  assert.equal(next, path);
  assert.equal(sanitizeNextPath(next), path);
});

test("allowing this page as a return path doesn't open anything else", () => {
  for (const raw of [
    "/connect",
    "/connect/imessagex",
    "/connect/imessage/../../evil",
    "/connect/imessage/..%2f..%2fevil",
    "//connect/imessage",
    "https://evil.example/connect/imessage",
  ]) {
    const safe = sanitizeNextPath(raw);
    const { pathname } = new URL(safe, SITE);
    assert.ok(
      pathname === "/app" ||
        pathname.startsWith("/app/") ||
        pathname === IMESSAGE_LINK_PATH ||
        pathname.startsWith(`${IMESSAGE_LINK_PATH}/`),
      `${raw} -> ${safe}`,
    );
    assert.notEqual(pathname, "/connect", raw);
    assert.notEqual(pathname, "/evil", raw);
  }
});

test("each claim error maps to its screen; anything else can be retried", () => {
  assert.equal(claimFailureFrom({ hint: "polya_imessage_signed_out" }), "signed_out");
  assert.equal(claimFailureFrom({ hint: "polya_imessage_code_invalid" }), "invalid");
  assert.equal(claimFailureFrom({ hint: "polya_imessage_code_used" }), "used");
  assert.equal(claimFailureFrom({ hint: "polya_imessage_code_expired" }), "expired");
  assert.equal(claimFailureFrom({ hint: null }), "unknown");
  assert.equal(claimFailureFrom({ hint: "constructor" }), "unknown");
  assert.equal(claimFailureFrom({}), "unknown");
  assert.equal(claimFailureFrom(null), "unknown");
});

test("the success screen shows a phone's last 4 digits, and nothing for an email", () => {
  assert.equal(phoneLastFour("0100"), "0100");
  assert.equal(phoneLastFour(".com"), null);
  assert.equal(phoneLastFour("du.e"), null);
  assert.equal(phoneLastFour("12345"), null);
  assert.equal(phoneLastFour(null), null);
  assert.equal(phoneLastFour(1234), null);
});

test("the confirm screen names a phone by its last 4 digits, and an email generically", () => {
  assert.deepEqual(linkTargetFromPeek("0100"), { lastFour: "0100" });
  assert.deepEqual(linkTargetFromPeek(EMAIL_HANDLE_MARKER), { lastFour: null });
  // Anything else means the link couldn't be checked; the page won't ask to confirm.
  for (const data of [null, undefined, "", ".com", "12345", 100, {}]) {
    assert.equal(linkTargetFromPeek(data), null, JSON.stringify(data));
  }
});

// The page and the migration have to agree on the RPCs' names, their error
// hints and the code shape.
const HINTS = [
  "polya_imessage_signed_out",
  "polya_imessage_code_invalid",
  "polya_imessage_code_used",
  "polya_imessage_code_expired",
];

function migrationSql(): string {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const file = readdirSync(dir).find((name) => /^\d{14}_polya_imessage\.sql$/.test(name));
  assert.ok(file, "polya_imessage migration exists");
  return readFileSync(new URL(file, dir), "utf8");
}

/** One function's definition, from `create or replace function` to its grant. */
function functionSql(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(code text)`);
  assert.ok(start >= 0, `${name} is defined`);
  const grant = `grant execute on function public.${name}(text) to authenticated;`;
  const end = sql.indexOf(grant, start);
  assert.ok(end > start, `${name} is granted to authenticated`);
  return sql.slice(start, end + grant.length);
}

test("wiring: the migration defines the peek and claim RPCs the page calls", () => {
  const sql = migrationSql();
  for (const name of [PEEK_RPC, CLAIM_RPC]) {
    const fn = functionSql(sql, name);
    assert.match(fn, /returns text\s+language plpgsql/, name);
    assert.match(fn, /security definer\s+set search_path = ''/, name);
    assert.ok(
      fn.includes(`revoke all on function public.${name}(text) from public, anon, authenticated;`),
      name,
    );
    assert.ok(fn.includes("'^[A-Za-z0-9_-]{6,128}$'"), `${name}: same code shape as parseLinkCode`);
    for (const hint of HINTS) {
      assert.ok(fn.includes(`hint = '${hint}'`), `${name}: ${hint}`);
      assert.notEqual(claimFailureFrom({ hint }), "unknown", hint);
    }
  }
});

test("wiring: peeking at a code changes nothing", () => {
  const body = functionSql(migrationSql(), PEEK_RPC)
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .toLowerCase();
  assert.match(body, /\bstable\b/);
  for (const write of [/\binsert\s+into\b/, /\bupdate\s+public\./, /\bdelete\s+from\b/, /\bperform\b/]) {
    assert.doesNotMatch(body, write);
  }
  assert.ok(body.includes(`return '${EMAIL_HANDLE_MARKER}'`), "email marker matches the page");
});
