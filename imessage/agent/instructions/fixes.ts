// Noel only: how to report and ship fixes, plus the lessons from his corrections that apply until
// their fixes ship. Resolved every turn so a new lesson takes effect on his next message; students'
// sessions get nothing. A missing table or a read error drops the lessons, never the turn.
import { defineDynamic, defineInstructions } from "eve/instructions";

import { serviceDb } from "../lib/db.ts";
import { activeLessons, canFileFixes, fixOwner, formatFixInstructions } from "../lib/fixes.ts";
import { loadActiveFixes } from "../lib/fixes-db.ts";
import { studentIdFrom } from "../lib/student.ts";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const ownerId = fixOwner(studentIdFrom(ctx.session.auth));
      if (!ownerId) return null;
      let lessons: ReturnType<typeof activeLessons> = [];
      try {
        const loaded = await loadActiveFixes(serviceDb(), ownerId);
        if (loaded.ok) lessons = activeLessons(loaded.value, new Date());
      } catch (error) {
        console.error("[polya fixes] lessons load threw:", error instanceof Error ? error.message : error);
      }
      const canFile = canFileFixes();
      // Counts only, so a turn where the fix tools were missing shows up in the runtime logs.
      console.info("[polya fixes] owner turn", { canFile, lessons: lessons.length });
      const content = formatFixInstructions(lessons, canFile);
      return content ? defineInstructions({ content }) : null;
    },
  },
});
