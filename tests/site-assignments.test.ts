import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assignmentDocument,
  extractAssignments,
  formatDue,
  parseDate,
  parseTime,
  resolveYear,
  titleFromDueText,
  zonedTimeToUtc,
} from "../supabase/functions/_shared/site-assignments.ts";
import { stripHtmlToText } from "../supabase/functions/_shared/canvas.ts";

const fixtures = join(import.meta.dirname, "fixtures", "course-site", "ds100-fa26");
// The day the fixtures were captured; due dates resolve relative to it.
const NOW = new Date("2026-10-15T19:00:00Z");

test("dates in the shapes course sites write them", () => {
  assert.deepEqual(parseDate("Fri, Sep 04"), { year: null, month: 9, day: 4, weekday: 5 });
  assert.deepEqual(parseDate("Due Sept. 18th, 2026"), { year: 2026, month: 9, day: 18, weekday: null });
  assert.deepEqual(parseDate("August 27th, 2026 at 11:59 PM"), { year: 2026, month: 8, day: 27, weekday: null });
  assert.deepEqual(parseDate("due 2026-12-04"), { year: 2026, month: 12, day: 4, weekday: null });
  assert.deepEqual(parseDate("Thu 10/1"), { year: null, month: 10, day: 1, weekday: 4 });
  assert.equal(parseDate("Homework N released Homework N-1 due"), null);
});

test("times of day", () => {
  assert.deepEqual(parseTime("11:59 PM"), { hour: 23, minute: 59 });
  assert.deepEqual(parseTime("due 5pm"), { hour: 17, minute: 0 });
  assert.deepEqual(parseTime("11:59:59 PM PST"), { hour: 23, minute: 59 });
  assert.deepEqual(parseTime("12:00 a.m."), { hour: 0, minute: 0 });
  assert.deepEqual(parseTime("by 23:00"), { hour: 23, minute: 0 });
  assert.deepEqual(parseTime("at noon"), { hour: 12, minute: 0 });
  assert.equal(parseTime("Fri, Sep 04"), null);
});

test("Pacific wall time converts to UTC on both sides of the DST change", () => {
  // PDT (UTC-7) in September, PST (UTC-8) in December.
  assert.equal(zonedTimeToUtc(2026, 9, 4, 23, 59, "America/Los_Angeles").toISOString(), "2026-09-05T06:59:00.000Z");
  assert.equal(zonedTimeToUtc(2026, 12, 4, 23, 59, "America/Los_Angeles").toISOString(), "2026-12-05T07:59:00.000Z");
  assert.equal(zonedTimeToUtc(2026, 11, 1, 1, 30, "America/New_York").toISOString(), "2026-11-01T05:30:00.000Z");
});

test("a yearless date takes the year its weekday fits, nearest now", () => {
  assert.equal(resolveYear({ year: null, month: 8, day: 26, weekday: 3 }, NOW), 2026); // Wed, Aug 26 2026
  assert.equal(resolveYear({ year: null, month: 1, day: 20, weekday: null }, NOW), 2027);
  assert.equal(resolveYear({ year: 2024, month: 6, day: 13, weekday: null }, NOW), 2024);
});

test("titles come from the words around 'due'", () => {
  assert.equal(titleFromDueText("Homework 0 Due Prerequisite Math"), "Homework 0: Prerequisite Math");
  assert.equal(titleFromDueText("Project A1 Due Housing I"), "Project A1: Housing I");
  assert.equal(titleFromDueText("Lab 3 due Friday, Oct 9 at 5pm"), "Lab 3");
  assert.equal(titleFromDueText("Due: Problem Set 4 (Oct 9)"), "Problem Set 4");
  assert.equal(
    titleFromDueText(
      "You can switch to the non-graded discussion option after the Pre-Semester Survey is due (August 27th, 2026 at 11:59 PM).",
    ),
    "Pre-Semester Survey",
  );
  assert.equal(titleFromDueText("Due at: 2026-11-02 11:59 PM", "HW 7"), "HW 7");
});

test("the Data 100 schedule yields every homework and project due date at 11:59 PM Pacific", () => {
  const html = readFileSync(join(fixtures, "schedule.html"), "utf8");
  const found = extractAssignments(html, { pageUrl: new URL("https://ds100.org/fa26/"), now: NOW });
  const byTitle = new Map(found.map((a) => [a.title, a]));

  assert.equal(byTitle.get("Homework 0: Prerequisite Math")?.dueAt, "2026-09-05T06:59:00.000Z");
  assert.equal(byTitle.get("Homework 0: Prerequisite Coding")?.dueAt, "2026-09-05T06:59:00.000Z");
  assert.equal(byTitle.get("Homework 1: Food Safety I")?.dueAt, "2026-09-12T06:59:00.000Z");
  assert.equal(byTitle.get("Project A1: Housing I")?.dueAt, "2026-10-31T06:59:00.000Z");
  // After the DST change: 11:59 PM PST is 07:59 UTC.
  assert.equal(byTitle.get("Project B2: Spam & Ham II")?.dueAt, "2026-12-05T07:59:00.000Z");

  // Releases, lectures, readings and exam windows aren't due dates.
  for (const assignment of found) {
    assert.match(assignment.title, /^(Homework|Project) /, assignment.title);
    assert.equal(assignment.timeGiven, false);
    assert.equal(assignment.timeZone, "America/Los_Angeles");
  }
  assert.equal(found.length, 14);

  // The item's own links travel with it (the handout lives in Google Drive).
  assert.ok(
    byTitle.get("Homework 0: Prerequisite Math")?.links.some((link) => link.url.startsWith("https://drive.google.com/file/d/")),
  );
  assert.ok(byTitle.get("Homework 1: Food Safety I")?.links.some((link) => link.url.includes("hw01.ipynb")));
});

test("a placeholder page's 2024 due date is dropped, a nearby one is kept", () => {
  const template = `<main><h1>HW 1: Recursion</h1><p>Due at: 2024-06-13 11:59:59 PM PST</p></main>`;
  assert.deepEqual(
    extractAssignments(template, { pageUrl: new URL("https://ds100.org/fa26/hw/hw01/"), pageTitle: "HW 1", now: NOW }),
    [],
  );

  const page = `<main><h2>Project 2</h2><ul><li>Checkpoint due Friday, Oct 23 at 5pm ET</li></ul></main>`;
  const [only] = extractAssignments(page, {
    pageUrl: new URL("https://cs.example.edu/proj2/"),
    pageTitle: "Project 2",
    now: NOW,
  });
  assert.equal(only?.title, "Checkpoint");
  assert.equal(only?.dueAt, "2026-10-23T21:00:00.000Z");
  assert.equal(only?.timeGiven, true);
  assert.equal(only?.timeZone, "America/New_York");
});

test("the stored assignment text says what's due and when, in the course's time zone", () => {
  const [assignment] = extractAssignments(
    `<table><tr><td>Fri, Sep 04</td><td><div><strong>Homework 0 Due</strong><a href="https://drive.google.com/file/d/1K-voW-utQJDzA2TPixJiHK5N33pBpQyx/view">Prerequisite Math</a></div></td></tr></table>`,
    { pageUrl: new URL("https://ds100.org/fa26/"), now: NOW },
  );
  assert.ok(assignment);
  assert.equal(formatDue(assignment), "Friday, September 4, 2026 at 11:59 PM PDT");
  const text = stripHtmlToText(assignmentDocument(assignment, "Data 100"));
  assert.match(text, /Homework 0: Prerequisite Math for Data 100 is due Friday, September 4, 2026 at 11:59 PM PDT\./);
  assert.match(text, /Prerequisite Math/);
});
