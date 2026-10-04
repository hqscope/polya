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
  /** Concrete instructions for the assistant, repeated in every tool result. */
  how_to_help: string[];
}

// Every mode teaches. A bare result ("acceleration is 0") is not help in any
// mode; the reasoning is the point.
const EXPLAIN_EVERY_TIME =
  "Explain the reasoning every time: name the course concept, show how it applies to this exact case step by step, cite the course passages you used by [n], and end with a quick check the student can reuse. Never reply with a bare answer.";

// The 2026-10-03 demo run: after the student switched Practice -> Open, the
// assistant kept applying the old mode until told to "check again".
const RECHECK =
  "The student can change this mode at any time: check get_course_rules again before each new coursework request instead of reusing a mode from earlier in the conversation.";

// The connector test (2026-10-03) showed the outside model holding the line on
// the first ask, then answering "what about the rest" outright. Each part of a
// multi-part problem is its own question.
const EACH_PART =
  "Treat every part of a multi-part problem (1a, 1b, each segment of a graph) as its own question. A follow-up like \"what about the rest\" or \"and the next one?\" is a new request under the same rules, not permission to answer.";

const RULES: Record<PolicyMode, Omit<StudyRules, "mode">> = {
  open: {
    label: "Open",
    summary: "Full answers and walkthroughs are fine when the student asks for them.",
    allowed: ["Full answers and worked solutions on request", "Explaining any concept from the course"],
    not_allowed: [],
    how_to_help: [
      "Give the full answer or worked solution when asked.",
      EXPLAIN_EVERY_TIME,
      RECHECK,
    ],
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
    how_to_help: [
      "On a problem, start with a guiding question or a hint that points at the right concept, and climb one step at a time as the student engages.",
      "Once the student has shown their own attempt at a part, you may walk through that part fully.",
      EACH_PART,
      EXPLAIN_EVERY_TIME,
      RECHECK,
    ],
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
    how_to_help: [
      "Before confirming or explaining any part, ask for the student's own answer to that part. A yes/no question from the student (\"is it accelerating?\") gets a question back (\"what does the slope tell you?\"), not the answer.",
      "After the student commits, say whether it's right, then explain why using the course concept, and correct any misconception.",
      "Give at most one guided step at a time when they're stuck.",
      EACH_PART,
      EXPLAIN_EVERY_TIME,
      RECHECK,
    ],
  },
  review: {
    label: "Review",
    summary: "After the deadline. Full worked solutions are fine, ideally followed by a related practice task.",
    allowed: ["Full worked solutions", "Suggesting a related practice task"],
    not_allowed: [],
    how_to_help: [
      "Give full worked solutions, with the reasoning at every step.",
      "End with one related practice task the student can try.",
      EXPLAIN_EVERY_TIME,
      RECHECK,
    ],
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

/** One line for the top of every search result, so the rule stays in view. */
export function rulesReminder(mode: PolicyMode): string {
  const rules = RULES[mode];
  const partRule = mode === "guided" || mode === "practice" ? " Each part of a problem is its own question." : "";
  return `${rules.label} mode (current as of this search; the student can change it): ${rules.summary}${partRule} Explain the reasoning and cite passages by [n]; never give a bare answer.`;
}

/** Content roles withheld from retrieval under a mode (practice hides solution keys). */
export function excludedRolesFor(mode: PolicyMode): string[] {
  return mode === "practice" ? ["solution_key"] : [];
}
