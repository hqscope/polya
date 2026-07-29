// Live probe of the Kaltura media-gallery access path against a real bcourses
// course, using the developer's own gitignored Canvas token. Exercises the
// SHIPPING _shared/kaltura.ts end-to-end and dumps REDACTED evidence to
// data/kaltura-probe/ so the parsers (and their test fixtures) stay locked to
// observed reality.
//
//   node scripts/probe/kaltura-probe.ts [courseId]
//
// Secrets hygiene: the token file and data/ are gitignored; the token and any
// KS are scrubbed before anything is written.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CanvasClient } from "../../supabase/functions/_shared/canvas.ts";
import {
  fetchBestTranscript,
  listCourseMediaEntries,
  listTranscriptAssets,
  openCourseMediaSession,
} from "../../supabase/functions/_shared/kaltura.ts";
import { parseTranscript } from "../../supabase/functions/_shared/transcripts.ts";

const BASE_URL = process.env.POLYA_PROBE_BASE_URL ?? "https://bcourses.berkeley.edu";
const COURSE_ID = process.argv[2] ?? "1554425";
const OUT_DIR = join(process.cwd(), "data", "kaltura-probe");

const token = readFileSync(join(process.cwd(), "noel_canvas_token.txt"), "utf8").trim();
if (!token) throw new Error("noel_canvas_token.txt is empty");

const secrets = new Set<string>([token]);
function redact(text: string): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[REDACTED]");
  return out
    .replace(/djJ8[A-Za-z0-9+/_\-=]{20,}/g, "[KS]")
    .replace(/([?&/]ks[/=])[A-Za-z0-9+/_\-=%]{20,}/gi, "$1[KS]");
}
function dump(name: string, content: string): void {
  writeFileSync(join(OUT_DIR, name), redact(content));
  console.log(`  wrote data/kaltura-probe/${name}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Probing course ${COURSE_ID} on ${BASE_URL}`);
  const client = new CanvasClient(BASE_URL, token);

  const media = await openCourseMediaSession(client, COURSE_ID);
  if (!media) {
    console.log("No media-gallery tool on this course.");
    return;
  }
  const { session, tool } = media;
  secrets.add(session.widgetKs);
  console.log(`  tool ${tool.id} "${tool.name}" → partner ${session.partnerId}, category ${session.categoryId}`);
  console.log(`  dance: ${session.diagnostics.join(" → ")}`);
  console.log(`  scraped ${session.entryIds.length} entry ids`);
  dump(
    "session.json",
    JSON.stringify(
      {
        serviceUrl: session.serviceUrl,
        partnerId: session.partnerId,
        categoryId: session.categoryId,
        entryCount: session.entryIds.length,
        entryIds: session.entryIds,
        diagnostics: session.diagnostics,
      },
      null,
      2,
    ),
  );

  const entries = await listCourseMediaEntries(session);
  dump("entries.json", JSON.stringify(entries, null, 2));
  console.log(`  ${entries.length} entries resolved`);

  const assetReport: unknown[] = [];
  let sampled = false;
  for (const entry of entries.slice(0, 6)) {
    const assets = await listTranscriptAssets(session, entry.entryId);
    assetReport.push({ entry: entry.entryId, title: entry.title, ...assets });
    if (sampled) continue;
    const transcript = await fetchBestTranscript(session, entry.entryId).catch((err) => {
      console.log(`  transcript fetch failed for ${entry.entryId}: ${err}`);
      return null;
    });
    if (transcript) {
      const raw = new TextDecoder().decode(transcript.bytes);
      const segments = parseTranscript(raw, transcript.kind);
      console.log(
        `  ${entry.entryId}: ${transcript.kind} (${transcript.bytes.byteLength} bytes) → ${segments.length} segments via ${transcript.label}`,
      );
      dump(
        "transcript-sample.txt",
        `entry=${entry.entryId} kind=${transcript.kind} bytes=${transcript.bytes.byteLength} segments=${segments.length}\n` +
          `first segment: ${JSON.stringify(segments[0])}\n---\n${raw.slice(0, 2000)}`,
      );
      sampled = true;
    }
  }
  dump("assets.json", JSON.stringify(assetReport, null, 2));
  console.log("Probe complete.");
}

main().catch((err) => {
  console.error("PROBE FAILED:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
