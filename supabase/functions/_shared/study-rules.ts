// A course's study rules in plain language, for surfaces where Polya doesn't
// write the answer itself (the ChatGPT / Claude connector). Mirrors the
// tutor's MODE_RULES in prompts.ts: keep the two in step when a mode changes.
//
// Pure: imported by Node tests and by the Next.js /mcp route.
import type { PolicyMode } from "./prompts.ts";

export interface StudyRules {
  mode: PolicyMode;
  label: string;
  summary: string;
  allowed: string[];
  not_allowed: string[];
}

const RULES: Record<PolicyMode, Omit<StudyRules, "mode">> = {
  open: {
    label: "Open",
    summary: "Full answers and walkthroughs are fine when the student asks for them.",
    allowed: ["Full answers and worked solutions on request", "Explaining any concept from the course"],
    not_allowed: [],
  },
  guided: {
    label: "Guided",
    summary:
      "Hints and steps first. Hold back a full solution to a problem until the student has shown an attempt in this conversation.",
    allowed: [
      "Explaining concepts and answering what/why questions fully",
      "Hints, a guiding question, or one step at a time on problems",
      "A worked example of a similar (not the same) problem",
    ],
    not_allowed: ["A full solution to a problem before the student has shown their own attempt"],
  },
  practice: {
    label: "Practice",
    summary:
      "Quiz stance. The student commits to an answer before anything is revealed, and help stops at one guided step.",
    allowed: ["Asking the student questions", "One guided step at a time", "Checking an answer after the student commits to it"],
    not_allowed: [
      "Stating an answer before the student commits to one",
      "More than one guided step at a time",
      "Using answer keys or posted solutions",
    ],
  },
  review: {
    label: "Review",
    summary: "After the deadline. Full worked solutions are fine, ideally followed by a related practice task.",
    allowed: ["Full worked solutions", "Suggesting a related practice task"],
    not_allowed: [],
  },
};

const MODES = new Set<PolicyMode>(["open", "guided", "practice", "review"]);

/** Unknown or missing modes fall back to guided, the tutor's default. */
export function normalizeMode(raw: string | null | undefined): PolicyMode {
  return raw && MODES.has(raw as PolicyMode) ? (raw as PolicyMode) : "guided";
}

export function studyRulesFor(mode: PolicyMode): StudyRules {
  return { mode, ...RULES[mode] };
}

/** Content roles withheld from retrieval under a mode (practice hides solution keys). */
export function excludedRolesFor(mode: PolicyMode): string[] {
  return mode === "practice" ? ["solution_key"] : [];
}
