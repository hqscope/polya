// Decides when the background import pump hands its lease to a fresh
// invocation. The edge runtime caps CPU time per invocation (a couple of
// seconds) far below the wall budget, and PDF work is where that CPU goes:
// pdf.js re-parses the whole document every step, then walks up to a page
// batch of text, then pdf-lib slices pages for OCR. A worker that kept
// claiming PDF batches until the 60s wall budget would be killed mid-loop,
// holding its lease and its sources' claims until both expire. So after any
// cycle that touched a PDF the worker hands off immediately; cheap cycles
// (HTML, transcripts) keep looping until the wall budget.
// Pure module: no runtime globals, so Node's test runner can import it.

export type PumpMove = "continue" | "handoff";

// Source kinds whose processing is CPU-heavy enough to end the invocation.
const CPU_HEAVY_KINDS = new Set(["pdf"]);

export function isCpuHeavySource(source: { source_kind: string }): boolean {
  return CPU_HEAVY_KINDS.has(source.source_kind);
}

export function nextPumpMove(
  advanced: ReadonlyArray<{ source_kind: string }>,
  now: number,
  deadline: number,
): PumpMove {
  if (now >= deadline) return "handoff";
  return advanced.some(isCpuHeavySource) ? "handoff" : "continue";
}
