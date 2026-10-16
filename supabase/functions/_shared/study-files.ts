// Study: a first guess at which course files are an exam's formula sheet and
// which are past exams, from the file name alone. The student confirms or
// changes every guess before anything uses it. Pure module: no runtime globals.

export type ExamFileKind = "formula_sheet" | "past_exam";

export function suggestExamFileKind(title: string | null | undefined): ExamFileKind | null {
  const raw = String(title ?? "").toLowerCase();
  // Underscores and hyphens read as spaces, so "Quiz3-formulas" and
  // "fa25_mt2_sol" split into words for the \b patterns below.
  const text = raw.replace(/[_\-.]+/g, " ");
  if (/\b(formula|formulas|formula sheet|cheat ?sheet|reference sheet|crib sheet|equation sheet)\b/.test(text)) {
    return "formula_sheet";
  }
  if (
    /\b(midterm|mt ?\d|final|finals|exam|exams|quiz|quizzes|q ?\d|practice (test|exam|midterm|final|quiz))\b/.test(text) ||
    /\b(mt|pq|q)\d+\b/.test(text)
  ) {
    return "past_exam";
  }
  return null;
}
