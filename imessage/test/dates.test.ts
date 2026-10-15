import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  calendarDaysBetween,
  describeDue,
  formatLocalDateTime,
  hoursUntilUtcMidnight,
  isValidTimeZone,
  localDateKey,
  localTimeContext,
  safeTimeZone,
} from "../agent/lib/dates.ts";

const LA = "America/Los_Angeles";
const NY = "America/New_York";

describe("timezones", () => {
  it("accepts IANA names and rejects others", () => {
    assert.equal(isValidTimeZone(LA), true);
    assert.equal(isValidTimeZone("UTC"), true);
    assert.equal(isValidTimeZone("Pacific Time"), false);
    assert.equal(isValidTimeZone(""), false);
  });

  it("falls back for a missing or unknown timezone", () => {
    assert.equal(safeTimeZone(NY), NY);
    assert.equal(safeTimeZone(null), LA);
    assert.equal(safeTimeZone("Mars/Olympus"), LA);
  });
});

describe("local dates", () => {
  // 2026-10-16 05:30 UTC is still Oct 15 in Los Angeles (PDT, UTC-7) but Oct 16 in New York.
  const instant = new Date("2026-10-16T05:30:00Z");

  it("uses the student's calendar date", () => {
    assert.equal(localDateKey(instant, LA), "2026-10-15");
    assert.equal(localDateKey(instant, NY), "2026-10-16");
  });

  it("counts calendar days, not 24-hour blocks", () => {
    const now = new Date("2026-10-16T06:00:00Z"); // Oct 15, 11:00 PM in LA
    const due = new Date("2026-10-16T08:00:00Z"); // Oct 16, 1:00 AM in LA
    assert.equal(calendarDaysBetween(now, due, LA), 1);
  });

  it("formats a local date and time", () => {
    assert.equal(formatLocalDateTime(new Date("2026-10-16T06:59:00Z"), LA), "Thu, Oct 15, 11:59 PM");
  });
});

describe("describeDue", () => {
  const now = new Date("2026-10-15T19:00:00Z"); // Thu, Oct 15, 12:00 PM in LA

  it("says today and tomorrow", () => {
    assert.equal(describeDue(new Date("2026-10-16T06:59:00Z"), now, LA), "today at 11:59 PM");
    assert.equal(describeDue(new Date("2026-10-16T16:00:00Z"), now, LA), "tomorrow at 9:00 AM");
  });

  it("names the weekday within a week", () => {
    assert.equal(describeDue(new Date("2026-10-18T00:00:00Z"), now, LA), "Saturday at 5:00 PM");
  });

  it("gives the date further out", () => {
    assert.equal(describeDue(new Date("2026-10-31T06:59:00Z"), now, LA), "Fri, Oct 30, 11:59 PM");
  });

  it("follows the student's timezone", () => {
    // 11:59 PM in LA is 2:59 AM the next day in New York.
    assert.equal(describeDue(new Date("2026-10-16T06:59:00Z"), now, NY), "tomorrow at 2:59 AM");
  });
});

describe("context and resets", () => {
  it("states the student's local time with the timezone", () => {
    assert.equal(
      localTimeContext(new Date("2026-10-15T22:04:00Z"), LA),
      "The student's local time is Thursday, October 15, 2026 at 3:04 PM (America/Los_Angeles).",
    );
  });

  it("counts whole hours to the next UTC midnight", () => {
    assert.equal(hoursUntilUtcMidnight(new Date("2026-10-15T19:00:00Z")), 5);
    assert.equal(hoursUntilUtcMidnight(new Date("2026-10-15T19:30:00Z")), 5);
    assert.equal(hoursUntilUtcMidnight(new Date("2026-10-15T23:59:00Z")), 1);
  });
});
