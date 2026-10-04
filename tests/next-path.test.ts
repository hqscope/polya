import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_NEXT_PATH,
  NEXT_PATH_HEADER,
  loginPathFor,
  sanitizeNextPath,
} from "../src/lib/auth/next-path.ts";

const SITE = "https://askpolya.com";

// Where the callback ends up: `NextResponse.redirect(new URL(nextPath, request.url))`.
function landsOn(nextPath: string): URL {
  return new URL(nextPath, `${SITE}/auth/callback?next=x`);
}

test("pages inside the app come back as they are", () => {
  for (const path of [
    "/app",
    "/app/connect",
    "/app/courses/3f2a9c1e-7b1d-4c55-9a51-0d6f2e8b1c44",
    "/app/courses/3f2a9c1e-7b1d-4c55-9a51-0d6f2e8b1c44/materials",
    "/app/courses/abc?c=conversation-1",
    "/app?welcome=1",
  ]) {
    assert.equal(sanitizeNextPath(path), path, path);
  }
});

test("a missing next falls back to the course list", () => {
  for (const raw of [null, undefined, ""]) {
    assert.equal(sanitizeNextPath(raw), DEFAULT_NEXT_PATH, String(raw));
  }
});

test("open-redirect attempts fall back to /app", () => {
  const hostile = [
    // other sites, with and without a scheme
    "https://evil.example",
    "http://evil.example/app",
    "javascript:alert(1)",
    "data:text/html,hi",
    "evil.example",
    "app",
    // protocol-relative, and the ways browsers turn things into it
    "//evil.example",
    "///evil.example",
    "//evil.example/app",
    "/\\evil.example",
    "\\\\evil.example",
    "\\/evil.example",
    "/app\\..\\..\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    " /app",
    "/app /x",
    "/app\u0000",
    "/app\u007f",
    // userinfo tricks
    "/@evil.example",
    "/app@evil.example",
    // same site, but not inside the app
    "/",
    "/login",
    "/auth/callback?next=https://evil.example",
    "/application",
    "/appx/courses",
    "/APP",
    "/app/../login",
    "/app/./../auth/login",
    "/app/%2e%2e/login",
    "/app/%2E%2E/%2e%2e/evil.example",
    "/app/..//evil.example",
    "/app/../..//evil.example",
    "/app/%2e%2e/%2e%2e//evil.example",
    // oversized
    `/app/${"a".repeat(3000)}`,
  ];
  for (const raw of hostile) {
    assert.equal(sanitizeNextPath(raw), DEFAULT_NEXT_PATH, JSON.stringify(raw));
  }
});

test("dot segments that stay inside the app are resolved before use", () => {
  assert.equal(sanitizeNextPath("/app/courses/../connect"), "/app/connect");
  assert.equal(sanitizeNextPath("/app/courses/%2e%2e/connect"), "/app/connect");
});

test("whatever comes out stays on this site and inside /app", () => {
  const inputs = [
    "/app/courses/x",
    "/app/%2F%2Fevil.example",
    "/app/%5Cevil.example",
    "/app/..%2f..%2fevil.example",
    "/app/@evil.example",
    "/app//..//evil.example",
    "/app/courses/x?next=//evil.example",
    "//evil.example",
    "/\\evil.example",
    "https://evil.example",
  ];
  for (const raw of inputs) {
    const safe = sanitizeNextPath(raw);
    const url = landsOn(safe);
    assert.equal(url.origin, SITE, `${JSON.stringify(raw)} -> ${safe}`);
    assert.ok(url.pathname === "/app" || url.pathname.startsWith("/app/"), `${raw} -> ${url.pathname}`);
    assert.ok(safe.startsWith("/") && !safe.startsWith("//"), safe);
  }
});

test("the sign-in URL carries the page, encoded, or /app", () => {
  assert.equal(
    loginPathFor("/app/courses/abc"),
    "/login?next=%2Fapp%2Fcourses%2Fabc",
  );
  assert.equal(
    loginPathFor("/app/courses/abc?c=1"),
    "/login?next=%2Fapp%2Fcourses%2Fabc%3Fc%3D1",
  );
  assert.equal(loginPathFor("/app/connect"), "/login?next=%2Fapp%2Fconnect");
  assert.equal(loginPathFor(null), "/login?next=%2Fapp");
  assert.equal(loginPathFor("//evil.example"), "/login?next=%2Fapp");
  // Round trip: what /login reads back is the same path.
  const next = new URL(loginPathFor("/app/courses/abc?c=1"), SITE).searchParams.get("next");
  assert.equal(sanitizeNextPath(next), "/app/courses/abc?c=1");
});

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("wiring: the proxy sets the path header on /app requests only", () => {
  const proxy = read("src/proxy.ts");
  assert.match(proxy, /export function proxy\(/);
  assert.match(proxy, /headers\.set\(NEXT_PATH_HEADER, sanitizeNextPath\(/);
  assert.match(proxy, /matcher:\s*\["\/app", "\/app\/:path\*"\]/);
  assert.equal(NEXT_PATH_HEADER, "x-polya-next-path");
});

test("wiring: no /app page hard-codes its sign-in return path any more", () => {
  for (const path of [
    "src/app/app/layout.tsx",
    "src/app/app/page.tsx",
    "src/app/app/connect/page.tsx",
    "src/app/app/courses/[id]/page.tsx",
    "src/app/app/courses/[id]/materials/page.tsx",
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /\/login\?next=/, path);
    assert.match(source, /return redirectToLogin\(\)/, path);
  }
});

test("wiring: every hop of sign-in re-checks next", () => {
  assert.match(read("src/app/login/page.tsx"), /sanitizeNextPath\(params\.next\)/);
  for (const path of ["src/app/auth/login/route.ts", "src/app/auth/callback/route.ts"]) {
    assert.match(
      read(path),
      /sanitizeNextPath\(request\.nextUrl\.searchParams\.get\("next"\)\)/,
      path,
    );
  }
});
