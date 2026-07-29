// Transcript parsing — .txt, Kaltura .json, .vtt, .srt → timed segments.
// Pure module (no runtime globals) so it's Node-testable.

export interface TranscriptSegment {
  ordinal: number;
  text: string;
  tStartMs: number | null;
  tEndMs: number | null;
}

const PLAIN_MIN_CHARS = 1200;
const PLAIN_MAX_CHARS = 2800;
const SEG_MIN_MS = 45_000;
const SEG_MAX_MS = 120_000;

export function parseTranscript(raw: string, kind: string): TranscriptSegment[] {
  const text = String(raw || "");
  switch (kind) {
    case "transcript_json":
      return parseKalturaJson(text);
    case "transcript_vtt":
      return parseCues(text, "vtt");
    case "transcript_srt":
      return parseCues(text, "srt");
    default:
      return parsePlainText(text);
  }
}

// ---- plain .txt: paragraph packing into ~1200–2800 char segments ----
export function parsePlainText(raw: string): TranscriptSegment[] {
  const paragraphs = raw
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const segments: TranscriptSegment[] = [];
  let buffer = "";
  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed) segments.push({ ordinal: segments.length, text: trimmed, tStartMs: null, tEndMs: null });
    buffer = "";
  };

  for (const paragraph of paragraphs) {
    if (buffer.length + paragraph.length + 1 > PLAIN_MAX_CHARS && buffer.length >= PLAIN_MIN_CHARS) {
      flush();
    }
    buffer = buffer ? `${buffer}\n${paragraph}` : paragraph;
    if (buffer.length >= PLAIN_MAX_CHARS) flush();
  }
  flush();

  // Single unbroken blob with no paragraph breaks: hard-wrap by length.
  if (segments.length === 0 && raw.trim()) {
    const clean = raw.replace(/\s+/g, " ").trim();
    for (let i = 0; i < clean.length; i += PLAIN_MAX_CHARS) {
      segments.push({
        ordinal: segments.length,
        text: clean.slice(i, i + PLAIN_MAX_CHARS),
        tStartMs: null,
        tEndMs: null,
      });
    }
  }
  return segments;
}

// ---- Kaltura .json: defensive walk for timed caption arrays ----
export function parseKalturaJson(raw: string): TranscriptSegment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const cues: Array<{ start: number | null; end: number | null; text: string }> = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const text = firstString(obj, ["text", "content", "transcript", "caption"]);
      const start = firstNumber(obj, ["startTime", "start", "startMs", "begin"]);
      const end = firstNumber(obj, ["endTime", "end", "endMs", "finish"]);
      if (text) {
        cues.push({ start: toMs(start), end: toMs(end), text: text.replace(/\s+/g, " ").trim() });
      }
      for (const value of Object.values(obj)) visit(value);
    }
  };
  visit(parsed);

  return mergeCues(cues.filter((cue) => cue.text));
}

// ---- .vtt / .srt cue parsing ----
export function parseCues(raw: string, format: "vtt" | "srt"): TranscriptSegment[] {
  const body = format === "vtt" ? raw.replace(/^WEBVTT[\s\S]*?(\n\n|\r\n\r\n)/, "") : raw;
  const blocks = body.replace(/\r\n/g, "\n").split(/\n{2,}/);

  const cues: Array<{ start: number | null; end: number | null; text: string }> = [];
  const timeLine = /(\d{1,2}:\d{2}:\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2})[.,](\d{3})/;

  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim());
    const timeIdx = lines.findIndex((line) => timeLine.test(line));
    if (timeIdx === -1) continue;
    const match = lines[timeIdx]!.match(timeLine)!;
    const start = hmsToMs(match[1]!, match[2]!);
    const end = hmsToMs(match[3]!, match[4]!);
    const text = lines
      .slice(timeIdx + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) cues.push({ start, end, text });
  }
  return mergeCues(cues);
}

// Merge short cues into 45–120s segments (close at a sentence end past 45s).
function mergeCues(
  cues: Array<{ start: number | null; end: number | null; text: string }>,
): TranscriptSegment[] {
  if (cues.length === 0) return [];
  const hasTiming = cues.some((cue) => cue.start !== null);
  if (!hasTiming) {
    // No timestamps — fall back to plain packing on the concatenated text.
    return parsePlainText(cues.map((cue) => cue.text).join("\n\n"));
  }

  const segments: TranscriptSegment[] = [];
  let curText = "";
  let curStart: number | null = null;
  let curEnd: number | null = null;

  const flush = () => {
    if (curText.trim()) {
      segments.push({ ordinal: segments.length, text: curText.trim(), tStartMs: curStart, tEndMs: curEnd });
    }
    curText = "";
    curStart = null;
    curEnd = null;
  };

  for (const cue of cues) {
    if (curStart === null) curStart = cue.start;
    curEnd = cue.end ?? curEnd;
    curText = curText ? `${curText} ${cue.text}` : cue.text;

    const elapsed = curStart !== null && curEnd !== null ? curEnd - curStart : 0;
    const endsSentence = /[.!?]["')\]]?$/.test(cue.text);
    if ((elapsed >= SEG_MIN_MS && endsSentence) || elapsed >= SEG_MAX_MS) flush();
  }
  flush();
  return segments;
}

// ---- helpers ----
function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}
function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}
// Kaltura mixes seconds and milliseconds; values above 100k are treated as ms.
function toMs(value: number | null): number | null {
  if (value === null) return null;
  return value > 100_000 ? Math.round(value) : Math.round(value * 1000);
}
function hmsToMs(hms: string, millis: string): number {
  const [h, m, s] = hms.split(":").map(Number);
  return ((h! * 60 + m!) * 60 + s!) * 1000 + Number(millis);
}
