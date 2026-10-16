import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanUploadTitle,
  isValidUploadPath,
  looksLikePdf,
  MAX_UPLOAD_TITLE_CHARS,
  uploadSpecFor,
} from "../supabase/functions/_shared/upload-checks.ts";

const UID = "11111111-2222-3333-4444-555555555555";
const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("only allowlisted kinds map to an origin and source kind", () => {
  assert.deepEqual(uploadSpecFor("pdf"), { origin: "upload_file", sourceKind: "pdf", ext: "pdf" });
  assert.equal(uploadSpecFor("transcript_vtt")?.origin, "upload_transcript");
  for (const bad of ["html", "PDF", "toString", "__proto__", "", null, 7, undefined]) {
    assert.equal(uploadSpecFor(bad), null, String(bad));
  }
});

test("upload paths must be the student's own uploads folder with the kind's extension", () => {
  const pdf = uploadSpecFor("pdf")!;
  assert.ok(isValidUploadPath(UID, `${UID}/uploads/${FILE}.pdf`, pdf));
  assert.ok(!isValidUploadPath(UID, `${UID}/uploads/${FILE}.txt`, pdf), "wrong extension");
  assert.ok(!isValidUploadPath(UID, `other-user/uploads/${FILE}.pdf`, pdf), "someone else's folder");
  assert.ok(!isValidUploadPath(UID, `${UID}/course/${FILE}.pdf`, pdf), "outside uploads/");
  assert.ok(!isValidUploadPath(UID, `${UID}/uploads/../x/${FILE}.pdf`, pdf), "traversal");
  assert.ok(!isValidUploadPath(UID, `${UID}/uploads/notes.pdf`, pdf), "not a generated name");
  assert.ok(!isValidUploadPath(UID, `${UID}/uploads/${FILE}.pdf/extra`, pdf));
  assert.ok(!isValidUploadPath(UID, 42, pdf));
});

test("titles are trimmed, single-line and capped", () => {
  assert.equal(cleanUploadTitle("  Pitman  ch. 3\n4  "), "Pitman ch. 3 4");
  assert.equal(cleanUploadTitle("x".repeat(500))!.length, MAX_UPLOAD_TITLE_CHARS);
  assert.equal(cleanUploadTitle("   "), null);
  assert.equal(cleanUploadTitle(undefined), null);
});

test("a PDF header anywhere in the first 1 KB counts; anything else doesn't", () => {
  const enc = new TextEncoder();
  assert.ok(looksLikePdf(enc.encode("%PDF-1.7\n...")));
  assert.ok(looksLikePdf(enc.encode(`${" ".repeat(600)}%PDF-1.4`)));
  assert.ok(!looksLikePdf(enc.encode(`${" ".repeat(1100)}%PDF-1.4`)));
  assert.ok(!looksLikePdf(enc.encode("<html>not a pdf</html>")));
  assert.ok(!looksLikePdf(enc.encode("%PDF")));
  assert.ok(!looksLikePdf(new Uint8Array(0)));
});
