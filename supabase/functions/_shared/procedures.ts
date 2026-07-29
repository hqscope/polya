// Procedure extraction — detect numbered methodological steps in slide/page
// text so the tutor can walk a student through the professor's own method.
// Heuristic: >= 3 consecutive ascending numbered markers, most starting with an
// imperative verb. Pure module (no runtime globals) so it's Node-testable.
import type { PageText } from "./chunker.ts";

export interface ProcedureStep {
  stepNumber: number;
  text: string;
  page: number;
}

export interface ExtractedProcedure {
  title: string;
  pageStart: number;
  pageEnd: number;
  steps: ProcedureStep[];
}

const MIN_STEPS = 3;

// A leading step marker: "1.", "2)", "Step 3:", "4 -" etc.
const STEP_MARKER = /^\s*(?:step\s*)?(\d{1,2})\s*[.):\-]\s+(.+)$/i;

// Verbs that commonly open a methodological step (imperative mood).
const IMPERATIVE = new Set([
  "find", "compute", "calculate", "solve", "set", "apply", "substitute", "draw",
  "check", "determine", "identify", "write", "define", "choose", "select",
  "measure", "estimate", "evaluate", "derive", "simplify", "factor", "expand",
  "integrate", "differentiate", "plot", "graph", "label", "convert", "assume",
  "let", "consider", "start", "begin", "add", "subtract", "multiply", "divide",
  "isolate", "rearrange", "test", "verify", "record", "observe", "note", "list",
  "count", "sort", "group", "match", "state", "form", "build", "make", "take",
]);

function looksImperative(text: string): boolean {
  const first = text.trim().toLowerCase().split(/\s+/)[0]?.replace(/[^a-z]/g, "") ?? "";
  return IMPERATIVE.has(first);
}

// Extract procedures from a page's lines: a run of >= 3 ascending numbered
// lines starting at 1 (or a low number), with a majority imperative.
function extractFromPage(page: PageText): ExtractedProcedure[] {
  const lines = page.text
    .replace(/\r\n/g, "\n")
    // getTextContent joins with spaces; split on step markers too.
    .split(/\n|(?=\s(?:step\s*)?\d{1,2}\s*[.):\-]\s)/i)
    .map((line) => line.trim())
    .filter(Boolean);

  const procedures: ExtractedProcedure[] = [];
  let run: ProcedureStep[] = [];
  let expected = 1;
  let titleGuess = "";

  const closeRun = () => {
    if (run.length >= MIN_STEPS) {
      const impCount = run.filter((step) => looksImperative(step.text)).length;
      if (impCount / run.length >= 0.6) {
        procedures.push({
          title: titleGuess || run[0]!.text.slice(0, 60),
          pageStart: page.pageNum,
          pageEnd: page.pageNum,
          steps: run.map((step, i) => ({ ...step, stepNumber: i + 1 })),
        });
      }
    }
    run = [];
    expected = 1;
  };

  for (const line of lines) {
    const match = line.match(STEP_MARKER);
    if (match) {
      const num = Number(match[1]);
      const body = match[2]!.trim();
      if (num === expected || (run.length === 0 && num <= 2)) {
        if (run.length === 0) expected = num;
        run.push({ stepNumber: num, text: body, page: page.pageNum });
        expected += 1;
      } else {
        closeRun();
        if (num <= 2) {
          run.push({ stepNumber: num, text: body, page: page.pageNum });
          expected = num + 1;
        }
      }
    } else if (run.length === 0 && line.length < 80) {
      // A short non-numbered line right before a run is a plausible title.
      titleGuess = line;
    }
  }
  closeRun();
  return procedures;
}

export function extractProcedures(pages: PageText[]): ExtractedProcedure[] {
  const all: ExtractedProcedure[] = [];
  for (const page of pages) {
    try {
      all.push(...extractFromPage(page));
    } catch {
      // Extraction is best-effort; never fail ingestion over it.
    }
  }
  return all;
}

// The whole-procedure retrieval text (title + all steps) for one embedding.
export function procedureText(procedure: ExtractedProcedure): string {
  const steps = procedure.steps.map((step) => `${step.stepNumber}. ${step.text}`).join("\n");
  return `Method: ${procedure.title}\n${steps}`;
}

// Per-step retrieval text, carrying the parent title for context.
export function stepText(procedure: ExtractedProcedure, step: ProcedureStep): string {
  return `Method: ${procedure.title}\nStep ${step.stepNumber} of ${procedure.steps.length}: ${step.text}`;
}
