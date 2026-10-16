import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  detectImageKind,
  encodeUnderCap,
  imagePathsInListing,
  imagePathsInMessages,
  pickImagePath,
  prepareImage,
  returnedFileName,
} from "../agent/lib/images.ts";

// A 32x24 HEIC made with macOS `sips -s format heic`.
const TINY_HEIC = Buffer.from(
  "AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABw21ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAABppcmVmAAAAAAAAAA5jZHNjAAIAAQABAAAA5mlwcnAAAADFaXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAAAgAAAAGAAAAAlpcm90AAAAABBwaXhpAAAAAAMICAgAAABxaHZjQwEDcAAAALAAAAAAAB7wAPz9+PgAAAsDoAABABdAAQwB//8DcAAAAwCwAAADAAADAB5wJKEAAQAjQgEBA3AAAAMAsAAAAwAAAwAeoBQgQcCDCuIe5FlU3AgIGAKiAAEACUQBwGFyyERTZAAAABlpcG1hAAAAAAAAAAEAAQaBAgMFhoQAAAAsaWxvYwAAAABEAAACAAEAAAABAAACRQAAAGUAAgAAAAEAAAH3AAAATgAAAAFtZGF0AAAAAAAAAMMAAAAGRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAGAAAAAAAAABhKAGvo8aARnzLfLcpqr91u3y3yR4jxS/wLMflj4tPoj6epMeqkKIN/RU9OCsB0Arr5n362BuoHCTRKai4v6j//FHf/x68f+XpN6ZZM/0mu2kf/evL1r5dfvHUjYDwptf/gA==",
  "base64",
);

const withHeader = (...parts: (string | number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const ftyp = (brand: string) => withHeader([0, 0, 0, 0x18], "ftyp", brand, [0, 0, 0, 0]);
const PNG = withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 0x0d]);
const label = (path: string, type: string) => ({ type: "text", text: `Attached file ${path} (${type})` });
const A = "/workspace/.eve/attachments/0123456789abcdef";
const B = "/workspace/.eve/attachments/fedcba9876543210";

describe("detectImageKind", () => {
  it("detects HEIC and HEIF by their ftyp brand", () => {
    for (const brand of ["heic", "heix", "mif1", "hevc"]) assert.equal(detectImageKind(ftyp(brand)), "heic", brand);
    assert.equal(detectImageKind(TINY_HEIC), "heic");
  });
  it("does not treat other ftyp files as HEIC", () => {
    assert.equal(detectImageKind(ftyp("avif")), null);
    assert.equal(detectImageKind(ftyp("isom")), null);
  });
  it("detects the formats that pass through", () => {
    assert.equal(detectImageKind(withHeader([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
    assert.equal(detectImageKind(PNG), "png");
    assert.equal(detectImageKind(withHeader("GIF89a")), "gif");
    assert.equal(detectImageKind(withHeader("GIF87a")), "gif");
    assert.equal(detectImageKind(withHeader("RIFF", [0, 0, 0, 0], "WEBP")), "webp");
  });
  it("rejects short and unknown bytes", () => {
    assert.equal(detectImageKind(new Uint8Array()), null);
    assert.equal(detectImageKind(withHeader("ftyp")), null);
    assert.equal(detectImageKind(withHeader("%PDF-1.7")), null);
  });
});

describe("encodeUnderCap", () => {
  const sized = (bytesAt: (q: number) => number, calls: number[]) => async (q: number) => {
    calls.push(q);
    return new Uint8Array(bytesAt(q));
  };
  it("returns the first quality that fits and stops there", async () => {
    const calls: number[] = [];
    const result = await encodeUnderCap(sized((q) => Math.round(q * 1000), calls), 600, [0.9, 0.7, 0.5, 0.3]);
    assert.equal(result?.quality, 0.5);
    assert.equal(result?.bytes.byteLength, 500);
    assert.deepEqual(calls, [0.9, 0.7, 0.5]);
  });
  it("accepts a result exactly at the cap", async () => {
    const result = await encodeUnderCap(sized(() => 600, []), 600, [0.9]);
    assert.equal(result?.quality, 0.9);
  });
  it("returns null when nothing fits", async () => {
    assert.equal(await encodeUnderCap(sized(() => 601, []), 600, [0.9, 0.1]), null);
  });
});

describe("prepareImage", () => {
  it("converts HEIC to a JPEG", async () => {
    const image = await prepareImage(TINY_HEIC);
    assert.ok(image.ok);
    assert.equal(image.mediaType, "image/jpeg");
    assert.equal(image.converted, true);
    assert.equal(detectImageKind(image.bytes), "jpeg");
  });
  it("gives up on a HEIC that can't get under the cap", async () => {
    const image = await prepareImage(TINY_HEIC, 10);
    assert.equal(image.ok, false);
  });
  it("passes supported images through unchanged", async () => {
    const image = await prepareImage(PNG);
    assert.ok(image.ok);
    assert.equal(image.mediaType, "image/png");
    assert.equal(image.converted, false);
    assert.equal(image.bytes, PNG);
  });
  it("refuses a pass-through image over the cap and non-images", async () => {
    assert.equal((await prepareImage(PNG, PNG.byteLength - 1)).ok, false);
    assert.equal((await prepareImage(withHeader("hello world!"))).ok, false);
  });
});

describe("choosing the attachment", () => {
  const messages = [
    { role: "user", content: [label(`${A}/IMG_1.HEIC`, "image/heic")] },
    { role: "assistant", content: "Got it." },
    { role: "user", content: [{ type: "text", text: "and this" }, { type: "file", filename: `${B}/IMG_2.heic`, mediaType: "image/heic" }] },
    { role: "user", content: [label(`${B}/notes.csv`, "text/csv")] },
  ];
  it("lists image paths newest first, skipping other files", () => {
    assert.deepEqual(imagePathsInMessages(messages), [`${B}/IMG_2.heic`, `${A}/IMG_1.HEIC`]);
  });
  it("reads eve sandbox refs and tool results", () => {
    const ref = new URL("eve-sandbox:");
    ref.searchParams.set("path", `${A}/scan.png`);
    const tool = { type: "tool-result", output: { type: "content", value: [label(`${B}/shot.webp`, "image/webp")] } };
    assert.deepEqual(imagePathsInMessages([{ role: "user", content: [{ type: "file", data: ref }] }, { role: "tool", content: [tool] }]), [
      `${B}/shot.webp`,
      `${A}/scan.png`,
    ]);
  });
  it("reads a listing", () => {
    assert.deepEqual(imagePathsInListing(`${B}/a.jpg\n${A}/b.pdf\n\n${A}/c.gif\n`), [`${B}/a.jpg`, `${A}/c.gif`]);
  });
  it("picks the newest, a full path, or a file name", () => {
    const newest = [`${B}/IMG_2.heic`, `${A}/IMG_1.HEIC`];
    assert.equal(pickImagePath(undefined, newest), `${B}/IMG_2.heic`);
    assert.equal(pickImagePath(" ", newest), `${B}/IMG_2.heic`);
    assert.equal(pickImagePath(`${A}/other.png`, newest), `${A}/other.png`);
    assert.equal(pickImagePath("img_1.heic", newest), `${A}/IMG_1.HEIC`);
    assert.equal(pickImagePath("IMG 2.heic", [`${A}/IMG_2.heic`]), `${A}/IMG_2.heic`);
    assert.equal(pickImagePath("missing.heic", newest), null);
    assert.equal(pickImagePath(undefined, []), null);
  });
  it("never opens a path outside the attachments folder", () => {
    assert.equal(pickImagePath(`${A}/../../secrets.png`, []), null);
    assert.equal(pickImagePath("/etc/passwd", []), null);
  });
  it("names converted photos .jpg", () => {
    assert.equal(returnedFileName(`${A}/IMG_8520.heic`, true), "IMG_8520.jpg");
    assert.equal(returnedFileName(`${A}/shot.png`, false), "shot.png");
  });
});
