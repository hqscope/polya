import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractCategoryIdFromPath,
  extractJsRedirect,
  extractPartnerId,
  parseLtiLaunchForm,
  pickBestTranscriptAsset,
  pickMediaGalleryTool,
  scrapeEntryIds,
  type AttachmentAssetInfo,
  type CaptionAssetInfo,
} from "../supabase/functions/_shared/kaltura.ts";

// Fixtures are modeled on the redacted shapes observed probing Berkeley's KMS
// (bcourses course 1554425): an LTI 1.3 OIDC init form, the KMS JS-redirect
// bootstrap, and the channel page's embedded partner id + entry ids.

test("pickMediaGalleryTool finds the Kaltura tool by host, not a fixed id", () => {
  const tools = [
    { id: "70546", name: "Google Assignments", url: "https://assignments.google.com/lti/a", domain: "assignments.google.com" },
    { id: "76876", name: "Hypothesis", url: "https://lms.hypothes.is/lti_launches", domain: null },
    { id: "90481", name: "Kaltura Video Plugin LTI 1.3", url: "https://kaf.berkeley.edu", domain: "kaf.berkeley.edu" },
  ];
  const picked = pickMediaGalleryTool(tools);
  assert.equal(picked?.id, "90481");
});

test("pickMediaGalleryTool ignores lookalikes and returns null when absent", () => {
  assert.equal(pickMediaGalleryTool([]), null);
  assert.equal(
    pickMediaGalleryTool([
      { id: "1", name: "Gradescope", url: "https://gradescope.com", domain: "gradescope.com" },
    ]),
    null,
  );
  // "My Media" alone (personal, not the course gallery) should not out-score a
  // real Kaltura-hosted gallery — but by itself it still qualifies as Kaltura.
  const picked = pickMediaGalleryTool([
    { id: "2", name: "Media Gallery", url: "https://1234.kaf.kaltura.com/hosted/index/course-gallery", domain: "1234.kaf.kaltura.com" },
  ]);
  assert.equal(picked?.id, "2");
});

test("parseLtiLaunchForm extracts the OIDC init form and its fields", () => {
  const html = `
    <html><body>
    <form action="https://kaf.berkeley.edu/hosted/index/oidc-init" class="hide" method="POST" id="tool_form_901">
      <input type="hidden" name="iss" value="https://canvas.instructure.com" />
      <input type="hidden" name="login_hint" value="f145765eea7b0dfce28b27ef" />
      <input type="hidden" name="client_id" value="10720000000000745" />
      <input type="hidden" name="lti_deployment_id" value="90481:000acc84" />
      <input type="hidden" name="target_link_uri" value="https://kaf.berkeley.edu/hosted/index/course-gallery" />
    </form>
    </body></html>`;
  const form = parseLtiLaunchForm(html);
  assert.ok(form);
  assert.equal(form!.action, "https://kaf.berkeley.edu/hosted/index/oidc-init");
  const fields = Object.fromEntries(form!.fields);
  assert.equal(fields.iss, "https://canvas.instructure.com");
  assert.equal(fields.client_id, "10720000000000745");
  assert.equal(fields.target_link_uri, "https://kaf.berkeley.edu/hosted/index/course-gallery");
});

test("parseLtiLaunchForm decodes entity-escaped values", () => {
  const html = `<form action="https://x/authorize"><input name="id_token" value="a&amp;b" /><input name="state" value="s" /></form>`;
  const form = parseLtiLaunchForm(html);
  assert.equal(Object.fromEntries(form!.fields).id_token, "a&b");
});

test("parseLtiLaunchForm skips non-LTI forms (e.g. a search box)", () => {
  const html = `<form action="/search"><input name="q" value="" /></form>`;
  assert.equal(parseLtiLaunchForm(html), null);
});

test("extractJsRedirect reads the KMS bootstrap redirect", () => {
  const html = `<script>if(!cookiesAllowed){document.write("...");}else{window.location.href = '/channel/1554425/410171172';}</script>`;
  assert.equal(extractJsRedirect(html), "/channel/1554425/410171172");
});

test("extractCategoryIdFromPath pulls the gallery category id", () => {
  assert.equal(extractCategoryIdFromPath("/channel/1554425/410171172"), "410171172");
  assert.equal(extractCategoryIdFromPath("https://kaf.berkeley.edu/channel/1554425/410171172"), "410171172");
  assert.equal(extractCategoryIdFromPath("/media/t/1_abcd1234"), null);
});

test("extractPartnerId finds the partner from channel config", () => {
  assert.equal(extractPartnerId('{"partnerId":2640881,"serviceUrl":"https://www.kaltura.com"}'), "2640881");
  assert.equal(extractPartnerId("https://cdnapisec.kaltura.com/p/2640881/embedPlaykitJs"), "2640881");
  assert.equal(extractPartnerId("no partner here"), null);
});

test("scrapeEntryIds collects entry ids server-rendered into the gallery", () => {
  const html = `
    <a href="/media/t/1_tts6asys">Lecture 1</a>
    <div data-entryid="1_7srhgfl2"></div>
    <script>{"entryId":"1_4xr5tfux"}</script>
    entry_id=1_tts6asys`;
  const ids = scrapeEntryIds(html);
  assert.deepEqual([...ids].sort(), ["1_4xr5tfux", "1_7srhgfl2", "1_tts6asys"]);
});

test("pickBestTranscriptAsset prefers English SRT captions", () => {
  const captions: CaptionAssetInfo[] = [
    { id: "c_vtt", format: "3", language: "English", fileExt: "vtt" },
    { id: "c_srt", format: "1", language: "English", fileExt: "srt" },
    { id: "c_dfxp", format: "2", language: "English", fileExt: "dfxp" },
  ];
  const pick = pickBestTranscriptAsset(captions, []);
  assert.equal(pick?.source, "caption");
  assert.equal(pick?.id, "c_srt");
  assert.equal(pick?.kind, "transcript_srt");
});

test("pickBestTranscriptAsset falls back to a WebVTT caption then the txt attachment", () => {
  const vttOnly = pickBestTranscriptAsset(
    [{ id: "c_vtt", format: "3", language: "en", fileExt: "vtt" }],
    [],
  );
  assert.equal(vttOnly?.kind, "transcript_vtt");

  // No usable caption (DFXP only) → plain-text attachment beats word-level json.
  const attachments: AttachmentAssetInfo[] = [
    { id: "a_json", filename: "659794622 - 1_tts6asys - PID 2640881.json", title: "", fileExt: "json" },
    { id: "a_txt", filename: "659794622 - 1_tts6asys - PID 2640881.txt", title: "", fileExt: "txt" },
  ];
  const pick = pickBestTranscriptAsset(
    [{ id: "c_dfxp", format: "2", language: "en", fileExt: "dfxp" }],
    attachments,
  );
  assert.equal(pick?.source, "attachment");
  assert.equal(pick?.id, "a_txt");
  assert.equal(pick?.kind, "transcript_txt");
});

test("pickBestTranscriptAsset returns null when nothing is usable", () => {
  assert.equal(pickBestTranscriptAsset([{ id: "c", format: "2", language: "en", fileExt: "dfxp" }], []), null);
  assert.equal(pickBestTranscriptAsset([], []), null);
});
