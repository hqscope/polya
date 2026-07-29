import type { TutorSource } from "@/lib/sse";

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "cite"; n: number };

// Split assistant prose into text runs and [n] citation markers so the UI can
// render inline citation pills (port of the extension's answer-render concept).
export function segmentCitations(text: string): Segment[] {
  const segments: Segment[] = [];
  const regex = /\[(\d{1,2})\]/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) {
      segments.push({ kind: "text", text: text.slice(last, match.index) });
    }
    segments.push({ kind: "cite", n: Number(match[1]) });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    segments.push({ kind: "text", text: text.slice(last) });
  }
  return segments;
}

export function timeLabel(ms: number | null): string | null {
  if (ms === null) return null;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Honest fallback labels: only claim what we can actually open. An untimed
// transcript is a "transcript passage", never a moment; a chunk is a passage.
const UNIT_TYPE_LABELS: Record<string, string> = {
  chunk: "passage",
  transcript_segment: "transcript passage",
  procedure: "method",
  procedure_step: "step",
};

// Short human label for a source's location (page range or transcript time).
export function sourceLocation(source: TutorSource): string {
  if (source.t_start_ms !== null) {
    const start = timeLabel(source.t_start_ms);
    const end = timeLabel(source.t_end_ms);
    return end ? `${start}–${end}` : (start ?? "transcript passage");
  }
  if (source.page_start !== null) {
    return source.page_end && source.page_end !== source.page_start
      ? `p.${source.page_start}–${source.page_end}`
      : `p.${source.page_start}`;
  }
  return UNIT_TYPE_LABELS[source.unit_type] ?? source.unit_type.replace("_", " ");
}
