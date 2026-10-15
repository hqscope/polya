import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  codeCleanupCutoff,
  generateLinkCode,
  hashLinkCode,
  isLinkCodeLive,
  LINK_CODE_TTL_MS,
  linkCodeExpiry,
  linkUrl,
} from "../agent/lib/link.ts";

// The claim RPC (polya_imessage_claim_code) accepts only this shape.
const CLAIMABLE_CODE = /^[A-Za-z0-9_-]{6,128}$/;

describe("link codes", () => {
  it("generates URL-safe codes the claim RPC accepts", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateLinkCode();
      assert.match(code, CLAIMABLE_CODE);
      assert.equal(code.length, 32);
    }
  });

  it("does not repeat codes", () => {
    const codes = new Set(Array.from({ length: 1000 }, () => generateLinkCode()));
    assert.equal(codes.size, 1000);
  });

  it("hashes as lowercase sha256 hex of the UTF-8 code, like the claim RPC", () => {
    assert.equal(hashLinkCode("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const code = generateLinkCode();
    assert.equal(hashLinkCode(code), createHash("sha256").update(Buffer.from(code, "utf8")).digest("hex"));
    assert.match(hashLinkCode(code), /^[0-9a-f]{64}$/);
  });

  it("expires 15 minutes after creation", () => {
    const now = new Date("2026-10-15T20:00:00Z");
    assert.equal(LINK_CODE_TTL_MS, 15 * 60 * 1000);
    assert.equal(linkCodeExpiry(now).toISOString(), "2026-10-15T20:15:00.000Z");
  });

  it("treats a code as live only while unused and unexpired", () => {
    const now = new Date("2026-10-15T20:10:00Z");
    assert.equal(isLinkCodeLive({ expires_at: "2026-10-15T20:15:00Z", used_at: null }, now), true);
    assert.equal(isLinkCodeLive({ expires_at: "2026-10-15T20:10:00Z", used_at: null }, now), false);
    assert.equal(isLinkCodeLive({ expires_at: "2026-10-15T20:15:00Z", used_at: "2026-10-15T20:05:00Z" }, now), false);
  });

  it("sweeps codes only a day after they expire", () => {
    assert.equal(codeCleanupCutoff(new Date("2026-10-15T20:00:00Z")).toISOString(), "2026-10-14T20:00:00.000Z");
  });
});

describe("linkUrl", () => {
  it("builds the connect page URL with the code", () => {
    assert.equal(linkUrl("https://askpolya.com", "abc_DEF-123"), "https://askpolya.com/connect/imessage?code=abc_DEF-123");
  });

  it("tolerates a trailing slash and works for a local dev URL", () => {
    assert.equal(linkUrl("https://askpolya.com/", "x1"), "https://askpolya.com/connect/imessage?code=x1");
    assert.equal(linkUrl("http://localhost:3000", "x1"), "http://localhost:3000/connect/imessage?code=x1");
  });
});
