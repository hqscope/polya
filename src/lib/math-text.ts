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

const OPENER_RE = /\\\(|\\\[|\$\$/g;
const CLOSER: Record<string, string> = { "\\(": "\\)", "\\[": "\\]", $$: "$$" };

export function splitMath(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let textStart = 0;
  let searchFrom = 0;

  const pushText = (end: number) => {
    if (end > textStart) segments.push({ kind: "text", text: text.slice(textStart, end) });
  };

  while (searchFrom < text.length) {
    OPENER_RE.lastIndex = searchFrom;
    const open = OPENER_RE.exec(text);
    if (!open) break;
    const opener = open[0];
    const bodyStart = open.index + opener.length;
    const close = text.indexOf(CLOSER[opener]!, bodyStart);
    if (close === -1) break;
    const tex = text.slice(bodyStart, close).trim();
    if (!tex) {
      // "\(\)" carries nothing to typeset; leave it in the text run.
      searchFrom = close + 2;
      continue;
    }
    pushText(open.index);
    segments.push({ kind: "math", tex, display: opener !== "\\(" });
    textStart = close + 2;
    searchFrom = textStart;
  }

  pushText(text.length);
  return segments;
}

/** True when the text contains at least one complete math run. */
export function hasMath(text: string): boolean {
  return splitMath(text).some((segment) => segment.kind === "math");
}
