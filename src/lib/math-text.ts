// Split prose into plain-text runs and LaTeX math runs, so the UI can typeset
// the math and hand everything else to the existing text renderers (citation
// pills, inline emphasis). Pure and dependency-free so `tests/` can import it
// under Node's test runner.
//
// Delimiters: \( … \) inline and \[ … \] display (what the tutor is asked to
// write), plus $$ … $$ display. A single $ is deliberately NOT math: statistics
// problems are full of dollar amounts ("win $5 with probability 1/2").
// An opener with no closer stays text — a streaming answer shows the raw
// characters until the closer arrives, rather than swallowing the rest.

export type MathSegment =
  | { kind: "text"; text: string }
  | { kind: "math"; tex: string; display: boolean };

/** A complete math run. `start`/`end` span the delimiters too. */
export interface MathRange {
  start: number;
  end: number;
  tex: string;
  display: boolean;
}

const OPENER_RE = /\\\(|\\\[|\$\$/g;
const CLOSER: Record<string, string> = { "\\(": "\\)", "\\[": "\\]", $$: "$$" };

interface MathScan {
  ranges: MathRange[];
  /** Index of the opener that has no closer (scanning stops there), or -1. */
  openAt: number;
  openDisplay: boolean;
}

function scanMath(text: string): MathScan {
  const ranges: MathRange[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    OPENER_RE.lastIndex = searchFrom;
    const open = OPENER_RE.exec(text);
    if (!open) break;
    const opener = open[0];
    const bodyStart = open.index + opener.length;
    const close = text.indexOf(CLOSER[opener]!, bodyStart);
    if (close === -1) return { ranges, openAt: open.index, openDisplay: opener !== "\\(" };
    const tex = text.slice(bodyStart, close).trim();
    if (tex) {
      ranges.push({ start: open.index, end: close + 2, tex, display: opener !== "\\(" });
    }
    // "\(\)" carries nothing to typeset; it stays in the text run.
    searchFrom = close + 2;
  }
  return { ranges, openAt: -1, openDisplay: false };
}

/** Every complete math run, in order. */
export function mathRanges(text: string): MathRange[] {
  return scanMath(text).ranges;
}

/**
 * Where a display-math run opens with no closer yet (a `\[` or `$$` still
 * streaming in), or -1. An unclosed inline `\(` doesn't count.
 */
export function openMathStart(text: string): number {
  const scan = scanMath(text);
  return scan.openAt !== -1 && scan.openDisplay ? scan.openAt : -1;
}

export function splitMath(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let textStart = 0;
  for (const range of mathRanges(text)) {
    if (range.start > textStart) segments.push({ kind: "text", text: text.slice(textStart, range.start) });
    segments.push({ kind: "math", tex: range.tex, display: range.display });
    textStart = range.end;
  }
  if (text.length > textStart) segments.push({ kind: "text", text: text.slice(textStart) });
  return segments;
}

/** True when the text contains at least one complete math run. */
export function hasMath(text: string): boolean {
  return mathRanges(text).length > 0;
}
