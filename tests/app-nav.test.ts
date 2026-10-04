import { test } from "node:test";
import assert from "node:assert/strict";

import { courseNavLabel, currentPlaceLabel, isCoursePath } from "../src/lib/app-nav.ts";

const courses = [
  { id: "c1", name: "Data Structures", code: "CS 61B" },
  { id: "c10", name: "Genetics", code: null },
  { id: "c2", name: "Organic Chemistry", code: "  " },
];

test("course label joins code and name, or falls back to the name", () => {
  assert.equal(courseNavLabel(courses[0]!), "CS 61B · Data Structures");
  assert.equal(courseNavLabel(courses[1]!), "Genetics");
});

test("isCoursePath matches whole segments only", () => {
  assert.equal(isCoursePath("/app/courses/c1", "c1"), true);
  assert.equal(isCoursePath("/app/courses/c1/materials", "c1"), true);
  assert.equal(isCoursePath("/app/courses/c10", "c1"), false);
  assert.equal(isCoursePath("/app/courses/c10/materials", "c1"), false);
  assert.equal(isCoursePath("/app", "c1"), false);
});

test("the phone menu button names where you are", () => {
  assert.equal(currentPlaceLabel("/app", courses), "My courses");
  assert.equal(currentPlaceLabel("/app/connect", courses), "Connect Canvas");
  assert.equal(currentPlaceLabel("/app/courses/c1", courses), "CS 61B");
  assert.equal(currentPlaceLabel("/app/courses/c1/materials", courses), "CS 61B");
  assert.equal(currentPlaceLabel("/app/courses/c10", courses), "Genetics");
  // A blank code falls back to the name.
  assert.equal(currentPlaceLabel("/app/courses/c2", courses), "Organic Chemistry");
  // A course that isn't in the list (just deleted, say) reads as the list.
  assert.equal(currentPlaceLabel("/app/courses/unknown", courses), "My courses");
});
