// Study: what's in a course, sorted the way a student preparing for an exam
// thinks about it — lectures, practice exams and whether each has its answer
// key, homework, section worksheets, readings — plus the files Polya couldn't
// read. Every count comes from the course's own rows, never from a model.
// Pure module: no runtime globals.

import { isAnswerKeyLike } from "./content-roles.ts";
import { suggestExamFileKind } from "./study-files.ts";

export type InventoryKind =
  | "lecture"
  | "recording"
  | "practice_exam"
  | "solution"
  | "homework"
  | "discussion"
  | "reading"
  | "syllabus"
  | "formula_sheet"
  | "other";

export const INVENTORY_KIND_LABEL: Record<InventoryKind, string> = {
  lecture: "Lectures",
  recording: "Lecture recordings",
  practice_exam: "Practice exams",
  solution: "Answer keys",
  homework: "Homework",
  discussion: "Discussion and section",
  reading: "Readings",
  syllabus: "Syllabus",
  formula_sheet: "Formula sheets",
  other: "Other files",
};

const GROUP_ORDER: InventoryKind[] = [
  "practice_exam",
  "solution",
  "formula_sheet",
  "lecture",
  "recording",
  "discussion",
  "homework",
  "reading",
  "syllabus",
  "other",
];

export interface InventorySource {
  id: string;
  title: string;
  status: string;
  origin?: string | null;
  source_kind?: string | null;
  content_role?: string | null;
  module_name?: string | null;
  folder_path?: string | null;
}

export interface InventoryMark {
  source_id: string;
  kind: string; // formula_sheet | past_exam
}

export interface InventoryItem {
  source_id: string;
  title: string;
  /** Practice exams only: whether a matching answer key was found. */
  has_solution?: boolean;
}

export interface InventoryGroup {
  kind: InventoryKind;
  label: string;
  count: number;
  items: InventoryItem[];
}

export interface InventoryTile {
  label: string;
  value: number;
  kind: InventoryKind | "total" | "unreadable";
}

export interface Inventory {
  total: number;
  readable: number;
  /** Still being read (imports in progress). */
  in_progress: number;
  tiles: InventoryTile[];
  groups: InventoryGroup[];
  exams_without_solutions: InventoryItem[];
  unreadable: (InventoryItem & { reason: string })[];
  marked: { formula_sheets: number; past_exams: number };
}

const GROUP_ITEMS_MAX = 40;
const IN_PROGRESS = new Set(["queued", "fetching", "parsing", "embedding"]);
const UNREADABLE_REASON: Record<string, string> = {
  needs_ocr: "looks like scanned pages",
  failed: "couldn't be opened",
  skipped: "was skipped",
};

function words(text: string): string {
  return text.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "").replace(/[_\-.()[\]]+/g, " ");
}

export function classifySource(source: InventorySource, markedKind?: string | null): InventoryKind {
  const title = source.title ?? "";
  const text = words(title);
  const context = words(`${source.module_name ?? ""} ${source.folder_path ?? ""}`);
  if (source.origin === "canvas_syllabus" || /\bsyllabus\b/.test(text)) return "syllabus";
  if (
    source.origin === "canvas_media" || source.origin === "upload_transcript" ||
    String(source.source_kind ?? "").startsWith("transcript")
  ) {
    return "recording";
  }
  if (source.content_role === "solution_key" || isAnswerKeyLike({ title })) return "solution";
  if (markedKind === "formula_sheet" || suggestExamFileKind(title) === "formula_sheet") return "formula_sheet";
  if (markedKind === "past_exam" || suggestExamFileKind(title) === "past_exam") return "practice_exam";
  if (source.origin === "canvas_assignment" || /\b(hw|homework|problem ?sets?|psets?|ps ?\d+)\b|\bhw ?\d/.test(text)) {
    return "homework";
  }
  if (/\b(disc|discussion|section|sections|worksheet|recitation|lab)\b|\b(disc|section|dis)\d/.test(text)) {
    return "discussion";
  }
  if (/\b(lec|lect|lecture|lectures|slides?)\b|\blec ?\d/.test(text)) return "lecture";
  if (/\b(chap|chapter|ch|reading|readings|textbook|notes)\b|\b(ch|chap|chapter) ?\d/.test(text)) return "reading";
  // Fall back on where the file sits in the course.
  if (/\b(lecture|lectures|slides)\b/.test(context)) return "lecture";
  if (/\b(discussion|section|worksheet)\b/.test(context)) return "discussion";
  if (/\b(homework|hw)\b/.test(context)) return "homework";
  return "other";
}

const SOLUTION_WORDS = new Set([
  "sol", "sols", "soln", "solns", "solution", "solutions", "answer", "answers", "key", "keys", "brief", "worked",
]);

/**
 * The words that identify a file once copy suffixes like "(1)" and solution
 * words are dropped: "midterm-practice1-brief-soln(1).pdf" → {midterm,
 * practice1}.
 */
export function titleSignature(title: string): Set<string> {
  const cleaned = title.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "").replace(/\(\d+\)/g, " ");
  return new Set(
    cleaned
      .split(/[^a-z0-9]+/)
      .filter((word) => word && !SOLUTION_WORDS.has(word)),
  );
}

const subset = (a: Set<string>, b: Set<string>) => [...a].every((word) => b.has(word));

/** Whether a solution file belongs to an exam: one's words all appear in the other's. */
export function solutionMatches(examTitle: string, solutionTitle: string): boolean {
  const exam = titleSignature(examTitle);
  const solution = titleSignature(solutionTitle);
  if (exam.size === 0 || solution.size === 0) return false;
  return subset(solution, exam) || subset(exam, solution);
}

export function buildInventory(sources: readonly InventorySource[], marks: readonly InventoryMark[] = []): Inventory {
  const markBySource = new Map(marks.map((mark) => [mark.source_id, mark.kind]));
  const readable = sources.filter((s) => s.status === "ready");
  const inProgress = sources.filter((s) => IN_PROGRESS.has(s.status)).length;
  const unreadable = sources
    .filter((s) => UNREADABLE_REASON[s.status])
    .map((s) => ({ source_id: s.id, title: s.title, reason: UNREADABLE_REASON[s.status]! }));

  const byKind = new Map<InventoryKind, InventorySource[]>();
  for (const source of readable) {
    const kind = classifySource(source, markBySource.get(source.id));
    const list = byKind.get(kind) ?? [];
    list.push(source);
    byKind.set(kind, list);
  }

  const solutions = byKind.get("solution") ?? [];
  const exams = byKind.get("practice_exam") ?? [];
  const examItems: InventoryItem[] = exams.map((exam) => ({
    source_id: exam.id,
    title: exam.title,
    has_solution: solutions.some((solution) => solutionMatches(exam.title, solution.title)),
  }));

  const groups: InventoryGroup[] = GROUP_ORDER.flatMap((kind) => {
    const list = byKind.get(kind) ?? [];
    if (list.length === 0) return [];
    const items = kind === "practice_exam"
      ? examItems
      : [...list]
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
        .map((s) => ({ source_id: s.id, title: s.title }));
    return [{ kind, label: INVENTORY_KIND_LABEL[kind], count: list.length, items: items.slice(0, GROUP_ITEMS_MAX) }];
  });

  // Six tiles at most; files that couldn't be read always get one.
  const tiles: InventoryTile[] = [{ kind: "total", label: "Course files", value: readable.length }];
  for (const kind of ["lecture", "practice_exam", "solution", "homework", "discussion", "reading", "recording"] as const) {
    const count = byKind.get(kind)?.length ?? 0;
    if (count > 0) tiles.push({ kind, label: INVENTORY_KIND_LABEL[kind], value: count });
  }
  if (unreadable.length > 0) {
    tiles.splice(5);
    tiles.push({ kind: "unreadable", label: "Couldn't be read", value: unreadable.length });
  }

  return {
    total: sources.length,
    readable: readable.length,
    in_progress: inProgress,
    tiles: tiles.slice(0, 6),
    groups,
    exams_without_solutions: examItems.filter((item) => !item.has_solution).map(({ source_id, title }) => ({ source_id, title })),
    unreadable: unreadable.slice(0, GROUP_ITEMS_MAX),
    marked: {
      formula_sheets: marks.filter((m) => m.kind === "formula_sheet").length,
      past_exams: marks.filter((m) => m.kind === "past_exam").length,
    },
  };
}

/** One paragraph for the coach's picture of the course. */
export function inventorySummary(inventory: Inventory): string {
  const counts = inventory.groups.map((g) => `${g.count} ${g.label.toLowerCase()}`).join(", ");
  const lines = [`${inventory.readable} readable course files${counts ? `: ${counts}` : ""}.`];
  if (inventory.in_progress > 0) lines.push(`${inventory.in_progress} more are still being read.`);
  const exams = inventory.groups.find((g) => g.kind === "practice_exam");
  if (exams) {
    lines.push(
      `Practice exams: ${exams.items.map((i) => `${i.title}${i.has_solution ? " (has answer key)" : " (no answer key found)"}`).join("; ")}.`,
    );
  }
  if (inventory.unreadable.length > 0) {
    lines.push(`Couldn't be read: ${inventory.unreadable.map((u) => `${u.title} (${u.reason})`).join("; ")}.`);
  }
  lines.push(
    `Marked for this exam: ${inventory.marked.formula_sheets} formula sheet(s), ${inventory.marked.past_exams} past exam(s).`,
  );
  return lines.join("\n");
}
