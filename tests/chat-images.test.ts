import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_IMAGES_MAX,
  earlierImages,
  EARLIER_PHOTO_ROWS,
  historyText,
  imagesFromMeta,
  isChatImagePath,
  messageWithPhotos,
  parseChatImages,
  photoBlocks,
  photoTitle,
  searchText,
} from "../supabase/functions/_shared/chat-images.ts";
import { checkMessageWithPhotos } from "../supabase/functions/_shared/tutor-limits.ts";
import { looksLikeJpeg, uploadSpecFor, isValidUploadPath } from "../supabase/functions/_shared/upload-checks.ts";

const USER = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";
const photo = (n: number, user = USER) => `${user}/chat/0000000${n}-aaaa-bbbb-cccc-dddddddddddd.jpg`;

test("only the student's own chat photos are accepted", () => {
  assert.ok(isChatImagePath(USER, photo(1)));
  assert.equal(isChatImagePath(USER, photo(1, OTHER)), false);
  assert.equal(isChatImagePath(USER, `${USER}/uploads/00000001-aaaa-bbbb-cccc-dddddddddddd.jpg`), false);
  assert.equal(isChatImagePath(USER, `${USER}/chat/../${OTHER}/chat/00000001-aaaa-bbbb-cccc-dddddddddddd.jpg`), false);
  assert.equal(isChatImagePath(USER, `${USER}/chat/00000001-aaaa-bbbb-cccc-dddddddddddd.png`), false);
  assert.equal(isChatImagePath(USER, 42), false);
});

test("the images field: absent is fine, a list is checked, deduped and capped", () => {
  assert.deepEqual(parseChatImages(USER, undefined), { ok: true, paths: [] });
  assert.deepEqual(parseChatImages(USER, null), { ok: true, paths: [] });
  assert.deepEqual(parseChatImages(USER, [photo(1), photo(1), photo(2)]), { ok: true, paths: [photo(1), photo(2)] });
  assert.deepEqual(parseChatImages(USER, "not a list"), { ok: false, reason: "invalid" });
  assert.deepEqual(parseChatImages(USER, [photo(1, OTHER)]), { ok: false, reason: "invalid" });
  const tooMany = Array.from({ length: CHAT_IMAGES_MAX + 1 }, (_, i) => photo(i + 1));
  assert.deepEqual(parseChatImages(USER, tooMany), { ok: false, reason: "too_many" });
});

test("a message with photos may have no text; without photos it still needs some", () => {
  assert.equal(checkMessageWithPhotos(undefined, 1), "ok");
  assert.equal(checkMessageWithPhotos("   ", 2), "ok");
  assert.equal(checkMessageWithPhotos("", 0), "missing");
  assert.equal(checkMessageWithPhotos(undefined, 0), "missing");
  assert.equal(checkMessageWithPhotos("x".repeat(9_000), 1), "too_long");
});

test("earlier photos come from the latest photo message, only while it's recent", () => {
  const rows = [
    { role: "assistant", meta: null },
    { role: "user", meta: { images: [photo(1), photo(2)] } },
    { role: "assistant", meta: null },
    { role: "user", meta: { images: [photo(3)] } },
  ];
  assert.deepEqual(earlierImages(USER, rows, 4), [photo(1), photo(2)]);
  assert.deepEqual(earlierImages(USER, rows, 1), [photo(1)]);
  assert.deepEqual(earlierImages(USER, rows, 0), []);
  // Someone else's path in stored meta is never shown.
  assert.deepEqual(earlierImages(USER, [{ role: "user", meta: { images: [photo(1, OTHER)] } }], 4), []);
  // Older than the last few rows: not shown again.
  const old = [...Array.from({ length: EARLIER_PHOTO_ROWS }, () => ({ role: "assistant", meta: null })), rows[1]!];
  assert.deepEqual(earlierImages(USER, old, 4), []);
});

test("stored meta and history text", () => {
  assert.deepEqual(imagesFromMeta({ images: [photo(1), 7] }), [photo(1)]);
  assert.deepEqual(imagesFromMeta({ kind: "open" }), []);
  assert.deepEqual(imagesFromMeta(null), []);
  assert.equal(historyText("what about b?", { images: [photo(1)] }), "what about b? [sent a photo]");
  assert.equal(historyText("", { images: [photo(1), photo(2)] }), "[sent 2 photos]");
  assert.equal(historyText("plain", null), "plain");
});

test("the turn's photo blocks and the note the model reads", () => {
  assert.deepEqual(photoBlocks(["https://a"], []), [{ type: "image", source: { type: "url", url: "https://a" } }]);
  assert.deepEqual(photoBlocks([], ["https://b"]), [
    { type: "text", text: "Earlier:" },
    { type: "image", source: { type: "url", url: "https://b" } },
  ]);
  assert.equal(messageWithPhotos("hi", 0, 0), "hi");
  assert.match(messageWithPhotos("", 1, 0), /^\(No text, just the photo\.\)\n\n\[The student attached a photo/);
  assert.match(messageWithPhotos("part b?", 0, 2), /The 2 photos marked "earlier" are from the student's previous message/);
});

test("titles and search text for a photo message", () => {
  assert.equal(photoTitle("", "\nFind P(X > 3) for X ~ Poisson(2)\nmore"), "Find P(X > 3) for X ~ Poisson(2)");
  assert.equal(photoTitle("", ""), "Photo question");
  assert.equal(photoTitle("typed", "photo text"), "typed");
  assert.equal(searchText(" typed ", " photo "), "typed\nphoto");
  assert.equal(searchText("", ""), "");
  assert.equal(searchText("a".repeat(2_000), "b").length, 1_500);
});

test("photo course materials: a JPEG in the student's uploads folder", () => {
  const spec = uploadSpecFor("image");
  assert.ok(spec);
  assert.equal(spec!.sourceKind, "image");
  assert.ok(isValidUploadPath(USER, `${USER}/uploads/00000001-aaaa-bbbb-cccc-dddddddddddd.jpg`, spec!));
  assert.equal(isValidUploadPath(USER, `${USER}/uploads/00000001-aaaa-bbbb-cccc-dddddddddddd.pdf`, spec!), false);
  assert.ok(looksLikeJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00])));
  assert.equal(looksLikeJpeg(new TextEncoder().encode("%PDF-1.7")), false);
  assert.equal(looksLikeJpeg(new Uint8Array([0xff, 0xd8])), false);
});
