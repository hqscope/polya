// Noel only: merges a fix's pull request once he has looked at it, through scope-ops' ship_task.
// The commit merged is the one scope-ops reported when the PR was ready (channels/fixes.ts), read
// from the database, never from the model; scope-ops refuses if the PR changed since. Resolved per
// turn like report_mistake, so students never see it.
import { defineDynamic, defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { serviceDb } from "../lib/db.ts";
import { canFileFixes, fixOwner, planShip } from "../lib/fixes.ts";
import { loadFix, updateFix } from "../lib/fixes-db.ts";
import { callScopeOps } from "../lib/scope-ops.ts";
import { requireStudentId, studentIdFrom } from "../lib/student.ts";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (!fixOwner(studentIdFrom(ctx.session.auth)) || !canFileFixes()) return null;
      return defineTool({
        description:
          "Noel only. Merges a fix's pull request so it goes live for every student. Use only when Noel asks in his own text to ship a fix. He confirms before it runs.",
        inputSchema: z.object({
          fix: z.number().int().positive().describe("The fix number from the latest [polya fix] message."),
          pr_url: z.string().url().describe("The PR link from the latest [polya fix] message for that fix."),
        }),
        approval: {
          request: always(),
          prompt: ({ input }) => `Merge fix #${input.fix} and put it live for every student?\n${input.pr_url}`,
        },
        label: { start: () => "Shipping a fix" },
        async execute(input, toolCtx) {
          const ownerId = fixOwner(requireStudentId(toolCtx.session.auth));
          if (!ownerId) return { shipped: false, reason: "Only Polya's owner can ship fixes." };
          const db = serviceDb();
          const loaded = await loadFix(db, ownerId, input.fix);
          if (!loaded.ok) return { shipped: false, reason: "Fixes aren't available right now." };
          const plan = planShip(loaded.value, input.pr_url);
          if (plan.kind === "refuse") return { shipped: false, reason: plan.reason };

          const result = await callScopeOps("ship_task", { task: plan.issueRef, expected_head_sha: plan.headSha });
          if (!result.ok) return { shipped: false, reason: result.text || "Scope Ops didn't merge it." };
          const marked = await updateFix(db, ownerId, input.fix, { status: "shipped" });
          return {
            shipped: true,
            pr_url: input.pr_url,
            next: "It goes live for every student with the next deploy, and the lesson is retired.",
            ...(marked.ok ? {} : { warning: "Merged, but Polya couldn't record it; the lesson may still show until scope-ops reports the merge." }),
          };
        },
      });
    },
  },
});
