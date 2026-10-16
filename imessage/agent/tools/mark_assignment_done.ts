import { defineTool } from "eve/tools";
import { z } from "zod";

import { safeTimeZone } from "../lib/dates.ts";
import { serviceDb } from "../lib/db.ts";
import { findLinkByUser } from "../lib/link.ts";
import { assignmentView } from "../lib/reminders.ts";
import { findStudentAssignment, saveMarks } from "../lib/reminders-db.ts";
import { requireStudentId } from "../lib/student.ts";

const MAX_MATCHES = 5;

export default defineTool({
  description:
    "Records that the student finished or turned in an assignment, so Polya stops reminding them about it. Call it when the student says they submitted, finished, or turned in an assignment. Pass the item_key from a check-in or from upcoming_assignments when you have it; otherwise pass the assignment's title words as the student said them. If several assignments match, it returns them so you can ask which one.",
  inputSchema: z.object({
    item_key: z.string().max(200).optional().describe("The item_key from a check-in or upcoming_assignments."),
    title: z.string().max(200).optional().describe("The assignment's title words, e.g. \"hw 7\" or \"Problem Set 4\"."),
  }),
  label: { start: () => "Updating your reminders" },
  async execute({ item_key, title }, ctx) {
    const userId = requireStudentId(ctx.session.auth);
    if (!item_key && !title) throw new Error("Pass the item_key or the assignment's title words.");
    const now = new Date();
    const db = serviceDb();
    const [pick, link] = await Promise.all([
      findStudentAssignment(userId, { itemKey: item_key, title }, now),
      findLinkByUser(db, userId),
    ]);
    const timeZone = safeTimeZone(link?.timezone);

    if (pick.kind === "none") {
      return {
        marked_done: false,
        reason: "No recent or upcoming assignment matches. Ask the student for the name as it appears in their course.",
      };
    }
    if (pick.kind === "ambiguous") {
      return {
        marked_done: false,
        reason: "Several assignments match. Ask the student which one they meant.",
        matches: pick.items.slice(0, MAX_MATCHES).map((item) => assignmentView(item, [], now, timeZone)),
      };
    }

    const saved = await saveMarks(userId, pick.item.keys, "done", null);
    const assignment = assignmentView(pick.item, [], now, timeZone);
    if (saved === "unavailable") {
      return { marked_done: false, assignment, reason: "Couldn't save this right now, so a reminder may still come." };
    }
    return { marked_done: true, assignment: { ...assignment, submission: "student said it's done" } };
  },
});
