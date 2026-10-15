import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDriveAuthUrl,
  connectResultFor,
  createPkcePair,
  decodeDriveFlow,
  DRIVE_START_PATH,
  driveStartHref,
  encodeDriveFlow,
  pkceChallenge,
  randomUrlSafe,
  readDriveCallback,
  readDriveResult,
  withDriveResult,
} from "../src/lib/google-drive-connect.ts";
import { GRANT_SCOPES } from "../supabase/functions/_shared/drive.ts";

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

test("PKCE: RFC 7636 appendix B vector, and fresh pairs look right", async () => {
  assert.equal(
    await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  const pair = await createPkcePair();
  assert.match(pair.verifier, VERIFIER_RE);
  assert.equal(pair.verifier.length, 43);
  assert.equal(pair.challenge, await pkceChallenge(pair.verifier));
  assert.notEqual((await createPkcePair()).verifier, pair.verifier);
  assert.match(randomUrlSafe(24), /^[A-Za-z0-9_-]{32}$/);
});

test("the consent URL asks for offline, consented, S256 access and nothing secret", () => {
  const url = new URL(
    buildDriveAuthUrl({
      clientId: "123.apps.googleusercontent.com",
      redirectUri: "https://askpolya.com/auth/google-drive/callback",
      scopes: GRANT_SCOPES,
      codeChallenge: "challenge",
      state: "state-state-state-1",
    }),
  );
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const p = url.searchParams;
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.equal(p.get("access_type"), "offline");
  assert.equal(p.get("prompt"), "consent");
  assert.equal(p.get("scope"), "openid email https://www.googleapis.com/auth/drive.readonly");
  assert.equal(p.get("redirect_uri"), "https://askpolya.com/auth/google-drive/callback");
  assert.equal(p.get("client_secret"), null);
});

test("the flow cookie round-trips and rejects anything that isn't ours", () => {
  const flow = { state: "abcdefghijklmnopqrstuvwxyz012345", verifier: "v".repeat(43), next: "/app/connect", uid: "6f1c2c4e-5a6b-4c3d-9e8f-0a1b2c3d4e5f" };
  const raw = encodeDriveFlow(flow);
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeDriveFlow(raw), flow);
  assert.equal(decodeDriveFlow(undefined), null);
  assert.equal(decodeDriveFlow("not-base64!"), null);
  assert.equal(decodeDriveFlow(encodeDriveFlow({ ...flow, verifier: "short" })), null);
  assert.equal(decodeDriveFlow(encodeDriveFlow({ ...flow, next: "https://evil.example" })), null);
  assert.equal(decodeDriveFlow(Buffer.from('{"state":1}').toString("base64url")), null);
});

test("Google's redirect: code on matching state, else a result to show", () => {
  const state = "abcdefghijklmnopqrstuvwxyz012345";
  const read = (query: string) => readDriveCallback(new URLSearchParams(query), state);
  assert.deepEqual(read(`code=4/0Ab&state=${state}&scope=x`), { ok: true, code: "4/0Ab" });
  assert.deepEqual(read(`error=access_denied&state=${state}`), { ok: false, result: "denied" });
  assert.deepEqual(read("error=admin_policy_enforced"), { ok: false, result: "error" });
  assert.deepEqual(read("code=4/0Ab&state=someone-elses-state"), { ok: false, result: "error" });
  assert.deepEqual(read(`state=${state}`), { ok: false, result: "error" });
});

test("connect answers become the page's result", () => {
  assert.equal(connectResultFor(200, undefined), "connected");
  assert.equal(connectResultFor(400, "denied"), "denied");
  assert.equal(connectResultFor(403, "coming_soon"), "unavailable");
  assert.equal(connectResultFor(503, "not_configured"), "unavailable");
  assert.equal(connectResultFor(400, "retry"), "error");
  assert.equal(connectResultFor(502, undefined), "error");
});

test("return paths carry one ?drive= result; the start link drops an old one", () => {
  assert.equal(withDriveResult("/app/connect", "connected"), "/app/connect?drive=connected");
  assert.equal(withDriveResult("/app/connect?site=1&drive=error", "denied"), "/app/connect?site=1&drive=denied");
  assert.equal(
    driveStartHref("/app/connect?site=1&drive=error"),
    `${DRIVE_START_PATH}?next=${encodeURIComponent("/app/connect?site=1")}`,
  );
  assert.equal(readDriveResult("?drive=connected"), "connected");
  assert.equal(readDriveResult("?drive=<script>"), null);
  assert.equal(readDriveResult(""), null);
});
