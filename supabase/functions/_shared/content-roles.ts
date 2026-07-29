// Content-role heuristics — port of the extension's isAnswerKeyLike /
// queryAllowsAnswerKeys (course-materials.js). Pure module: no runtime globals.

export interface RoleSignals {
  title?: string | null;
  folderPath?: string | null;
  moduleName?: string | null;
  text?: string | null;
}

export function isAnswerKeyLike(signals: RoleSignals): boolean {
  const raw = [signals.title, signals.folderPath, signals.moduleName, signals.text]
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase();
  // Match against the raw text (keeps the extension's explicit `dps_sol` token)
  // AND an underscore-normalized copy, so common filenames like
  // `ps3_solutions.pdf` or `hw4_answers.pdf` still trip the `\b`-anchored
  // patterns (an underscore is a word char, so it wouldn't otherwise boundary).
  const blob = `${raw} ${raw.replace(/_/g, " ")}`;
  return /\b(answer\s*key|answers?|solutions?|worksheet\s+solutions?|sol\.?pdf|dps_sol)\b/.test(
    blob,
  );
}

export function queryAllowsAnswerKeys(query: string): boolean {
  return /\b(answer|answers|solution|solutions|key|worked|worksheet)\b/i.test(
    String(query || ""),
  );
}

export type ContentRole = "material" | "syllabus" | "assignment" | "solution_key";

export function classifyContentRole(signals: RoleSignals & { origin?: string }): ContentRole {
  if (signals.origin === "canvas_syllabus") return "syllabus";
  if (signals.origin === "canvas_assignment") return "assignment";
  if (isAnswerKeyLike(signals)) return "solution_key";
  return "material";
}
