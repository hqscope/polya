// Shared presentation mapping for polya_sources.status values.

export function sourceStatusLabel(status: string): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "failed":
      return "Couldn't read";
    case "needs_ocr":
      return "Scanned — skipped";
    case "skipped":
      return "Skipped";
    default:
      return "Working…";
  }
}

export function sourceStatusClass(status: string): string {
  switch (status) {
    case "ready":
      return "text-accent-ink";
    case "failed":
      return "text-danger";
    case "needs_ocr":
      return "text-amber";
    default:
      return "text-ink3";
  }
}

// Short badge text for a source. Lecture videos read as "video" regardless of
// the underlying transcript format; otherwise "transcript_vtt" → "vtt".
export function sourceKindBadge(kind: string, origin?: string): string {
  if (origin === "canvas_media") return "video";
  return kind.startsWith("transcript_")
    ? kind.slice("transcript_".length)
    : kind;
}
