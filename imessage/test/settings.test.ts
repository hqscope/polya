import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeSettings, planSettingsUpdate } from "../agent/lib/settings.ts";

const CURRENT = { check_ins_enabled: true, quiet_start: 22, quiet_end: 8, timezone: "America/Los_Angeles" };

describe("planSettingsUpdate", () => {
  it("reads when nothing changes", () => {
    assert.deepEqual(planSettingsUpdate(CURRENT, {}), { kind: "read" });
  });

  it("pauses and resumes check-ins", () => {
    assert.deepEqual(planSettingsUpdate(CURRENT, { enabled: false }), {
      kind: "update",
      patch: { check_ins_enabled: false },
    });
    assert.deepEqual(planSettingsUpdate(CURRENT, { enabled: true }), {
      kind: "update",
      patch: { check_ins_enabled: true },
    });
  });

  it("sets a valid timezone and rejects an unknown one", () => {
    assert.deepEqual(planSettingsUpdate(CURRENT, { timezone: " America/New_York " }), {
      kind: "update",
      patch: { timezone: "America/New_York" },
    });
    assert.equal(planSettingsUpdate(CURRENT, { timezone: "Eastern" }).kind, "invalid");
  });

  it("changes one quiet-hour edge against the stored other edge", () => {
    assert.deepEqual(planSettingsUpdate(CURRENT, { quiet_end: 9 }), { kind: "update", patch: { quiet_end: 9 } });
    assert.deepEqual(planSettingsUpdate(CURRENT, { quiet_start: 23, quiet_end: 7 }), {
      kind: "update",
      patch: { quiet_start: 23, quiet_end: 7 },
    });
  });

  it("rejects quiet hours that start and end at the same hour", () => {
    assert.equal(planSettingsUpdate(CURRENT, { quiet_end: 22 }).kind, "invalid");
  });

  it("rejects hours outside 0-23", () => {
    assert.equal(planSettingsUpdate(CURRENT, { quiet_start: 24 }).kind, "invalid");
    assert.equal(planSettingsUpdate(CURRENT, { quiet_end: 7.5 }).kind, "invalid");
  });
});

describe("describeSettings", () => {
  it("words the settings for a reply", () => {
    assert.deepEqual(describeSettings(CURRENT), {
      check_ins: "on",
      quiet_hours: "10 PM to 8 AM",
      quiet_start: 22,
      quiet_end: 8,
      timezone: "America/Los_Angeles",
    });
    assert.equal(describeSettings({ ...CURRENT, check_ins_enabled: false, quiet_start: 0, quiet_end: 12 }).quiet_hours, "12 AM to 12 PM");
  });
});
