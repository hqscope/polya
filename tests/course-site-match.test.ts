import { test } from "node:test";
import assert from "node:assert/strict";

import { suggestCourseForSite, type SiteCourseOption } from "../src/lib/course-site-match.ts";

const COURSES: SiteCourseOption[] = [
  { id: "data100", name: "Principles & Techniques of Data Science (Fall 2026)", code: "DATA C100" },
  { id: "cs61b", name: "Data Structures", code: "COMPSCI 61B" },
  { id: "mcb102", name: "Survey of the Principles of Biochemistry", code: "MCELLBI 102" },
  { id: "nocode", name: "Reading Group", code: null },
];

test("suggestCourseForSite matches the course number in the address", () => {
  assert.equal(suggestCourseForSite("ds100.org/fa26", COURSES), "data100");
  assert.equal(suggestCourseForSite("https://sp26.datastructur.es/ cs61b", COURSES), "cs61b");
  assert.equal(suggestCourseForSite("https://cs61b.org/", COURSES), "cs61b");
});

test("suggestCourseForSite ignores term codes, other digits, and ambiguity", () => {
  // "fa26" is a term, not a course number; "1000" isn't "100".
  assert.equal(suggestCourseForSite("example.edu/fa26/", [{ id: "x", name: "Course", code: "STAT 26" }]), null);
  assert.equal(suggestCourseForSite("example.edu/course1000/", COURSES), null);
  assert.equal(suggestCourseForSite("example.edu/100-and-102/", COURSES), null);
  assert.equal(suggestCourseForSite("", COURSES), null);
  assert.equal(suggestCourseForSite("ds100.org/fa26", []), null);
});
