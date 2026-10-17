import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildInventory,
  classifySource,
  inventorySummary,
  solutionMatches,
  type InventorySource,
} from "../supabase/functions/_shared/study-inventory.ts";

let n = 0;
const src = (title: string, over: Partial<InventorySource> = {}): InventorySource => ({
  id: `s${++n}`,
  title,
  status: "ready",
  origin: "canvas_file",
  source_kind: "pdf",
  content_role: "material",
  ...over,
});

test("course file names sort into the kinds a student studies by", () => {
  const cases: [string, Partial<InventorySource>, string][] = [
    ["Lec19-stat134-Fall26(1).pdf", {}, "lecture"],
    ["Lec 07 Slides.pdf", {}, "lecture"],
    ["F26_Stat_134_midterm-practice1-2.pdf", {}, "practice_exam"],
    ["F26_Stat_134_midterm-practice1-brief-soln(1).pdf", {}, "solution"],
    ["soln-section10.pdf", {}, "solution"],
    ["fa25_mt2_sol.pdf", {}, "solution"],
    ["HW12-13-14(2).pdf", {}, "homework"],
    ["section7.pdf", {}, "discussion"],
    ["STAT134 Discussion 11 (1).pdf", {}, "discussion"],
    ["Disc 03.pdf", {}, "discussion"],
    ["chap1 from Pitman-Probabilty.pdf", {}, "reading"],
    ["Quiz3-formulas.pdf", {}, "formula_sheet"],
    ["Stat 134 syllabus-2(1).pdf", {}, "syllabus"],
    ["Syllabus", { origin: "canvas_syllabus", source_kind: "html" }, "syllabus"],
    ["Lecture 4 recording", { origin: "canvas_media", source_kind: "transcript_vtt" }, "recording"],
    ["Stat_134_MGF_problems(1).pdf", {}, "other"],
    ["Week 3 overview", { module_name: "Lecture slides" }, "lecture"],
  ];
  for (const [title, over, kind] of cases) assert.equal(classifySource(src(title, over)), kind, title);
  // A file the student marked wins over its name.
  assert.equal(classifySource(src("Problems for Monday.pdf"), "past_exam"), "practice_exam");
});

test("practice exams pair with their answer keys despite copy suffixes and solution words", () => {
  assert.equal(solutionMatches("F26_Stat_134_midterm-practice1-2.pdf", "F26_Stat_134_midterm-practice1-brief-soln(1).pdf"), true);
  assert.equal(solutionMatches("F26_Stat_134_midterm-practice2-2.pdf", "F26_Stat_134_midterm-practice1-brief-soln(1).pdf"), false);
  assert.equal(solutionMatches("midterm_practice_questions-2.pdf", "midterm_practice_questions_solutions-2(1).pdf"), true);
  assert.equal(solutionMatches("fa25_mt2.pdf", "fa25_mt2_sol.pdf"), true);
  assert.equal(solutionMatches("Conceptual_midterm_review.pdf", "Conceptual_midterm_review_solns(1).pdf"), true);
});

test("the inventory counts real rows, flags missing keys and unreadable files", () => {
  const exam1 = src("F26_Stat_134_midterm-practice1-2.pdf");
  const exam2 = src("F26_Stat_134_midterm-practice2-2.pdf");
  const sources = [
    exam1,
    exam2,
    src("F26_Stat_134_midterm-practice1-brief-soln(1).pdf"),
    src("Lec1-stat134-Fall26.pdf"),
    src("Lec2-stat134-fall26.pdf"),
    src("HW1-2.pdf"),
    src("Scanned notes.pdf", { status: "needs_ocr" }),
    src("Broken.pdf", { status: "failed" }),
    src("Still coming.pdf", { status: "parsing" }),
  ];
  const inv = buildInventory(sources, [{ source_id: exam1.id, kind: "past_exam" }]);
  assert.equal(inv.total, 9);
  assert.equal(inv.readable, 6);
  assert.equal(inv.in_progress, 1);
  assert.deepEqual(inv.exams_without_solutions, [{ source_id: exam2.id, title: exam2.title }]);
  assert.deepEqual(inv.unreadable.map((u) => u.reason), ["looks like scanned pages", "couldn't be opened"]);
  assert.deepEqual(inv.tiles[0], { kind: "total", label: "Course files", value: 6 });
  assert.ok(inv.tiles.some((t) => t.kind === "unreadable" && t.value === 2));
  assert.ok(inv.tiles.length <= 6);
  assert.deepEqual(inv.groups.map((g) => g.kind), ["practice_exam", "solution", "lecture", "homework"]);
  assert.deepEqual(inv.marked, { formula_sheets: 0, past_exams: 1 });
  const summary = inventorySummary(inv);
  assert.match(summary, /no answer key found/);
  assert.match(summary, /Scanned notes\.pdf \(looks like scanned pages\)/);
});

test("the couldn't-be-read tile survives the six-tile limit", () => {
  const many = ["Lec1.pdf", "mt1.pdf", "mt1_sol.pdf", "HW1.pdf", "section1.pdf", "chap1.pdf", "Lecture 4 recording"].map((t) =>
    src(t, t.includes("recording") ? { origin: "canvas_media", source_kind: "transcript_vtt" } : {})
  );
  const inv = buildInventory([...many, src("scan.pdf", { status: "needs_ocr" })]);
  assert.equal(inv.tiles.length, 6);
  assert.equal(inv.tiles.at(-1)!.kind, "unreadable");
});
