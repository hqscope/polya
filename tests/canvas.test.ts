import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractCanvasFileIds,
  extractKalturaEntryIds,
  normalizeBaseUrl,
  parseLinkNext,
  stripHtmlToText,
} from "../supabase/functions/_shared/canvas.ts";

test("extractCanvasFileIds pulls ids from the shapes Canvas emits", () => {
  const html = `
    <p>See the slides:</p>
    <a class="instructure_file_link"
       href="/courses/1549777/files/98765/download?download_frd=1"
       data-api-endpoint="https://bcourses.berkeley.edu/api/v1/courses/1549777/files/98765">
       Lab 1 Lecture Slides</a>
    <a href="/files/24680/download">Handout</a>
  `;
  assert.deepEqual(extractCanvasFileIds(html).sort(), ["24680", "98765"]);
});

test("extractCanvasFileIds dedupes a file referenced multiple ways", () => {
  const html = `
    <a href="/courses/9/files/555">a</a>
    <a data-api-endpoint="https://x/api/v1/courses/9/files/555">b</a>
    <a href="/files/555/download">c</a>
  `;
  assert.deepEqual(extractCanvasFileIds(html), ["555"]);
});

test("extractCanvasFileIds returns [] when there are no file links", () => {
  assert.deepEqual(extractCanvasFileIds("<p>Just text, no files.</p>"), []);
  assert.deepEqual(extractCanvasFileIds(""), []);
  assert.deepEqual(extractCanvasFileIds(null), []);
});

test("extractKalturaEntryIds pulls lecture-video entry ids from embed shapes", () => {
  const html = `
    <iframe src="/courses/1/external_tools/retrieve?url=https%3A%2F%2Fkaf.berkeley.edu%2Fbrowseandembed%2Findex%2Fmedia%2Fentryid%2F1_4cf7shct%2FshowDescription%2Ffalse"></iframe>
    <div class="kaltura-player" data-entryid="1_abcd1234"></div>
    <script>var config = {"entryId":"0_zzzz9999"};</script>
    <a href="https://kaf.berkeley.edu/media/t/1_4cf7shct">watch</a>`;
  assert.deepEqual(extractKalturaEntryIds(html).sort(), ["0_zzzz9999", "1_4cf7shct", "1_abcd1234"]);
});

test("extractKalturaEntryIds ignores prose and non-entry tokens", () => {
  assert.deepEqual(extractKalturaEntryIds("<p>See entry 1 for details.</p>"), []);
  assert.deepEqual(extractKalturaEntryIds(""), []);
  assert.deepEqual(extractKalturaEntryIds(null), []);
});

test("normalizeBaseUrl keeps only protocol + host and adds https", () => {
  assert.equal(normalizeBaseUrl("bcourses.berkeley.edu"), "https://bcourses.berkeley.edu");
  assert.equal(
    normalizeBaseUrl("https://bcourses.berkeley.edu/courses/123"),
    "https://bcourses.berkeley.edu",
  );
  assert.equal(normalizeBaseUrl("canvas.instructure.com"), "https://canvas.instructure.com");
});

test("normalizeBaseUrl rejects insecure schemes and non-public hosts", () => {
  const rejected = [
    "http://canvas.school.edu", // https only
    "10.0.0.1",
    "127.0.0.1",
    "2130706433", // decimal IPv4
    "0x7f000001", // hex IPv4
    "https://[::1]",
    "localhost",
    "foo.localhost",
    "printer.local",
    "metadata.internal",
    "router.home.arpa",
    "intranet", // no dot
    "https://user:pass@canvas.school.edu",
    "https://canvas.school.edu:8443", // nonstandard port
    "ftp://canvas.school.edu",
    "",
  ];
  for (const value of rejected) {
    assert.throws(() => normalizeBaseUrl(value), Error, `expected reject: ${value}`);
  }
});

test("normalizeBaseUrl allowInsecure permits local test servers only when asked", () => {
  assert.equal(
    normalizeBaseUrl("http://127.0.0.1:8971", { allowInsecure: true }),
    "http://127.0.0.1:8971",
  );
  // Still normalizes real hosts the same way with the flag on.
  assert.equal(
    normalizeBaseUrl("bcourses.berkeley.edu", { allowInsecure: true }),
    "https://bcourses.berkeley.edu",
  );
});

test("parseLinkNext extracts the rel=next url", () => {
  const header =
    '<https://x/api/v1/courses/1/files?page=1>; rel="current", ' +
    '<https://x/api/v1/courses/1/files?page=2>; rel="next"';
  assert.equal(parseLinkNext(header), "https://x/api/v1/courses/1/files?page=2");
  assert.equal(parseLinkNext(null), null);
});

test("stripHtmlToText decodes entities and preserves block breaks", () => {
  const text = stripHtmlToText("<p>Vmax&nbsp;is the max rate</p><li>step one</li>");
  assert.match(text, /Vmax is the max rate/);
  assert.match(text, /• step one/);
});
