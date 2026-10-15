import { defineTool } from "eve/tools";
import { z } from "zod";

import { serviceDb } from "../lib/db.ts";
import { findLinkByUser, updateLinkSettings } from "../lib/link.ts";
import { describeSettings, planSettingsUpdate } from "../lib/settings.ts";
import { requireStudentId } from "../lib/student.ts";

const hour = z.number().int().min(0).max(23);

export default defineTool({
  description:
    "Reads or changes the student's check-in settings: check-ins on or off, quiet hours (local hours when no check-ins are sent, from quiet_start up to quiet_end), and the student's timezone. Call it with no fields to read the current settings. Returns the settings after the change.",
  inputSchema: z.object({
    enabled: z.boolean().optional().describe("true to turn check-ins on, false to pause them."),
    quiet_start: hour.optional().describe("Local hour (0-23) when quiet time starts, e.g. 22 for 10 PM."),
    quiet_end: hour.optional().describe("Local hour (0-23) when quiet time ends, e.g. 8 for 8 AM."),
    timezone: z.string().max(64).optional().describe("IANA timezone name, e.g. America/New_York."),
  }),
  label: { start: () => "Updating your check-in settings" },
  async execute(input, ctx) {
    const userId = requireStudentId(ctx.session.auth);
    const db = serviceDb();
    const current = await findLinkByUser(db, userId);
    if (!current) throw new Error("This number isn't connected to a Polya account anymore.");

    const plan = planSettingsUpdate(current, input);
    if (plan.kind === "invalid") throw new Error(plan.reason);
    if (plan.kind === "read") return { changed: false, settings: describeSettings(current) };

    const updated = await updateLinkSettings(db, userId, plan.patch);
    if (!updated) throw new Error("This number isn't connected to a Polya account anymore.");
    return { changed: true, settings: describeSettings(updated) };
  },
});
