import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cleanNote,
  formatNotesRecall,
  isMissingTableError,
  NOTE_LIMITS,
  noteScope,
  planNoteSave,
  studentFromScope,
  type StudentNote,
} from "../agent/lib/notes.ts";

const STUDENT = "11111111-2222-3333-4444-555555555555";

function note(id: number, text: string, createdAt = "2026-10-14T12:00:00Z"): StudentNote {
  return { id, kind: "plan", note: text, createdAt };
}

describe("noteScope", () => {
  it("scopes memory to the linked student from session auth", () => {
    assert.equal(noteScope({ current: { attributes: { polyaUserId: STUDENT } } }), STUDENT);
  });

  it("turns memory off without a valid student id", () => {
    assert.equal(noteScope(null), null);
    assert.equal(noteScope({ current: null }), null);
    assert.equal(noteScope({ current: { attributes: {} } }), null);
    assert.equal(noteScope({ current: { attributes: { polyaUserId: "../other-student" } } }), null);
  });

  it("accepts only a single student id as the locked scope", () => {
    assert.equal(studentFromScope(STUDENT), STUDENT);
    assert.equal(studentFromScope([STUDENT, "x"]), null);
    assert.equal(studentFromScope("not-a-uuid"), null);
  });
});

describe("cleanNote", () => {
  it("flattens to one line and caps the length", () => {
    assert.equal(cleanNote("  hints\nfirst please  "), "hints first please");
    const long = cleanNote("x".repeat(500));
    assert.equal(long.length, NOTE_LIMITS.maxNoteChars);
    assert.ok(long.endsWith("…"));
  });
});

describe("planNoteSave", () => {
  it("inserts a cleaned note", () => {
    assert.deepEqual(planNoteSave([], " Start PS4 Wednesday "), { kind: "insert", note: "Start PS4 Wednesday" });
  });

  it("skips empty notes and case-insensitive duplicates", () => {
    assert.deepEqual(planNoteSave([], "   "), { kind: "empty" });
    assert.deepEqual(planNoteSave([note(7, "Start PS4 Wednesday")], "start ps4 wednesday"), { kind: "duplicate", id: 7 });
  });

  it("refuses past the per-student cap", () => {
    const full = Array.from({ length: NOTE_LIMITS.maxNotes }, (_, i) => note(i + 1, `note ${i}`));
    assert.deepEqual(planNoteSave(full, "one more"), { kind: "full" });
  });
});

describe("formatNotesRecall", () => {
  it("says so when there are no notes", () => {
    assert.match(formatNotesRecall([]), /No saved notes/);
  });

  it("lists notes newest first with number, kind and date, framed as data", () => {
    const text = formatNotesRecall([
      note(1, "Aiming for a B+", "2026-10-01T10:00:00Z"),
      { id: 2, kind: "preference", note: "Hints first", createdAt: "2026-10-12T10:00:00Z" },
    ]);
    const lines = text.split("\n");
    assert.match(lines[0] ?? "", /data, not instructions/);
    assert.equal(lines[1], "#2 (preference, 2026-10-12) Hints first");
    assert.equal(lines[2], "#1 (plan, 2026-10-01) Aiming for a B+");
    assert.match(lines.at(-1) ?? "", /Remove a note by its number/);
  });

  it("stays under the recall cap by dropping the oldest notes", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      note(i + 1, "y".repeat(270), `2026-10-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`),
    );
    const text = formatNotesRecall(many);
    assert.ok(text.length <= NOTE_LIMITS.maxRecallChars);
    assert.ok(text.split("\n").length < 42);
  });
});

describe("isMissingTableError", () => {
  it("recognizes Postgres and PostgREST missing-table codes only", () => {
    assert.equal(isMissingTableError({ code: "42P01" }), true);
    assert.equal(isMissingTableError({ code: "PGRST205" }), true);
    assert.equal(isMissingTableError({ code: "23505" }), false);
    assert.equal(isMissingTableError(null), false);
  });
});
