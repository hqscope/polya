import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseKalturaJson,
  parseCues,
  parsePlainText,
  parseTranscript,
} from "../supabase/functions/_shared/transcripts.ts";

test("vtt cues merge into 45-120s segments with timing", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:20.000",
    "Today we cover cellular respiration and where the energy comes from.",
    "",
    "00:00:20.000 --> 00:00:50.000",
    "Oxygen is the terminal electron acceptor in the chain.",
    "",
    "00:00:50.000 --> 00:01:20.000",
    "That is why you need to breathe. Next we look at glycolysis.",
    "",
    "00:01:20.000 --> 00:01:40.000",
    "Glycolysis happens in the cytosol.",
  ].join("\n");

  const segments = parseCues(vtt, "vtt");
  assert.ok(segments.length >= 1);
  assert.equal(segments[0]!.tStartMs, 0);
  // first segment closes at a sentence end past 45s (the 50s cue ends "…breathe.")
  assert.ok(segments[0]!.tEndMs !== null && segments[0]!.tEndMs >= 45_000);
  assert.match(segments[0]!.text, /electron acceptor/);
});

test("srt timestamps (comma millis) parse", () => {
  const srt = [
    "1",
    "00:00:01,000 --> 00:00:04,000",
    "Step one of the method.",
    "",
    "2",
    "00:00:04,000 --> 00:00:07,000",
    "Step two of the method.",
  ].join("\n");
  const segments = parseCues(srt, "srt");
  assert.equal(segments.length, 1); // short → merged into one
  assert.equal(segments[0]!.tStartMs, 1000);
});

test("kaltura json walks timed caption arrays (seconds and ms)", () => {
  const json = JSON.stringify({
    captions: [
      { startTime: 5, endTime: 9, text: "Welcome to lecture two." },
      { startTime: 9, endTime: 65, content: "Oxygen accepts electrons at the end of the chain." },
    ],
  });
  const segments = parseKalturaJson(json);
  assert.ok(segments.length >= 1);
  assert.equal(segments[0]!.tStartMs, 5000); // 5s → ms
  assert.match(segments.map((s) => s.text).join(" "), /Oxygen accepts electrons/);
});

test("malformed kaltura json yields no segments (no throw)", () => {
  assert.deepEqual(parseKalturaJson("{not json"), []);
});

test("plain text packs into segments", () => {
  const para = "Cellular respiration releases energy from glucose. ".repeat(40);
  const segments = parsePlainText(`${para}\n\n${para}\n\n${para}`);
  assert.ok(segments.length >= 1);
  assert.equal(segments[0]!.tStartMs, null);
  assert.ok(segments.every((s) => s.text.length <= 2800));
});

test("parseTranscript dispatches on kind", () => {
  assert.equal(parseTranscript("00:00:01,000 --> 00:00:03,000\nHi", "transcript_srt")[0]!.tStartMs, 1000);
  assert.equal(parseTranscript("plain words here", "transcript_txt")[0]!.tStartMs, null);
});
