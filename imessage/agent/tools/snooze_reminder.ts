import { defineTool } from "eve/tools";
import { z } from "zod";

import { formatLocalDateTime, safeTimeZone } from "../lib/dates.ts";
import { serviceDb } from "../lib/db.ts";
import { findLinkByUser } from "../lib/link.ts";
import { assignmentView } from "../lib/reminders.ts";
import { findStudentAssignment, saveMarks } from "../lib/reminders-db.ts";
import { requireStudentId } from "../lib/student.ts";

const HOUR_MS = 60 * 60 * 1000;
const MAX_SNOOZE_MS = 14 * 24 * HOUR_MS;
const MIN_SNOOZE_MS = 10 * 60 * 1000;
const MAX_MATCHES = 5;

export default defineTool({
  description:
    "Pauses reminders about one assignment until a time, when the student asks to be reminded later (\"remind me tomorrow\", \"not today\"). Pass the item_key from a check-in or upcoming_assignments when you have it, otherwise the title words. Give either `until` (an ISO 8601 time with the student's UTC offset, worked out from their local time) or `hours` from now. At most 14 days.",
  inputSchema: z.object({
    item_key: z.string().max(200).optional().describe("The item_key from a check-in or upcoming_assignments."),
    title: z.string().max(200).optional().describe("The assignment's title words, e.g. \"hw 7\"."),
    until: z
      .string()
      .max(40)
      .optional()
      .describe("When reminders may resume, e.g. 2026-10-16T09:00:00-07:00."),
    hours: z.number().int().min(1).max(336).optional().describe("Hours from now, instead of `until`."),
  }),
  label: { start: () => "Updating your reminders" },
  async execute({ item_key, title, until, hours }, ctx) {
    const userId = requireStudentId(ctx.session.auth);
    if (!item_key && !title) throw new Error("Pass the item_key or the assignment's title words.");
    if ((until === undefined) === (hours === undefined)) throw new Error("Pass exactly one of `until` or `hours`.");

    const now = new Date();
    const resume = until !== undefined ? new Date(until) : new Date(now.getTime() + (hours ?? 0) * HOUR_MS);
    const ahead = resume.getTime() - now.getTime();
    if (!Number.isFinite(ahead)) throw new Error("`until` must be an ISO 8601 time with an offset.");
    if (ahead < MIN_SNOOZE_MS) throw new Error("`until` must be in the future.");
    if (ahead > MAX_SNOOZE_MS) throw new Error("Snooze for at most 14 days.");

    const db = serviceDb();
    const [pick, link] = await Promise.all([
      findStudentAssignment(userId, { itemKey: item_key, title }, now),
      findLinkByUser(db, userId),
    ]);
    const timeZone = safeTimeZone(link?.timezone);

    if (pick.kind === "none") {
      return {
        snoozed: false,
        reason: "No recent or upcoming assignment matches. Ask the student for the name as it appears in their course.",
      };
    }
    if (pick.kind === "ambiguous") {
      return {
        snoozed: false,
        reason: "Several assignments match. Ask the student which one they meant.",
        matches: pick.items.slice(0, MAX_MATCHES).map((item) => assignmentView(item, [], now, timeZone)),
      };
    }

    const saved = await saveMarks(userId, pick.item.keys, "snoozed", resume);
    const assignment = assignmentView(pick.item, [], now, timeZone);
    if (saved === "unavailable") {
      return { snoozed: false, assignment, reason: "Couldn't save this right now, so a reminder may still come." };
    }
    return { snoozed: true, assignment, reminders_resume: formatLocalDateTime(resume, timeZone) };
  },
});
