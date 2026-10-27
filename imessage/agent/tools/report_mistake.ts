// Noel only: he texted that Polya got something wrong. Saves a lesson that applies in his own
// conversations right away (instructions/fixes.ts) and files the fix with scope-ops, whose cloud
// agent opens a pull request. Resolved per turn, so the tool exists only in the owner's sessions
// while scope-ops is connected; students never see it. See lib/fixes.ts for the whole loop.
import { defineDynamic, defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { serviceDb } from "../lib/db.ts";
import { activeLessons, buildFixRequest, canFileFixes, cleanText, FIX_LIMITS, fixOwner, issueRefFromUrl, issueUrlFromHandoff, MISTAKE_WHERE } from "../lib/fixes.ts";
import { attachIssue, insertFix, loadActiveFixes } from "../lib/fixes-db.ts";
import { callScopeOps } from "../lib/scope-ops.ts";
import { requireStudentId, studentIdFrom } from "../lib/student.ts";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (!fixOwner(studentIdFrom(ctx.session.auth)) || !canFileFixes()) return null;
      return defineTool({
        description:
          "Noel only. Use when Noel says, in his own words, that something you texted was wrong. Saves a lesson you follow in his conversations from now on, and files a fix for every student that he reviews before it ships. He confirms before it runs.",
        inputSchema: z.object({
          lesson: z
            .string()
            .min(10)
            .max(400)
            .describe("The corrected rule in one or two sentences you can follow from now on."),
          what_was_wrong: z.string().min(3).max(1000).describe("What Noel said was wrong, close to his words."),
          what_polya_did: z
            .string()
            .min(3)
            .max(1000)
            .describe("What you texted, in general terms: no names, email addresses, or message text."),
          replying_to: z
            .string()
            .max(1000)
            .optional()
            .describe("What you were responding to (his text, a check-in, a digest item), in general terms."),
          where: z.enum(MISTAKE_WHERE).describe("Which kind of message the mistake was in."),
        }),
        approval: {
          request: always(),
          prompt: ({ input }) =>
            `Send this fix?\n\n${input.lesson}\n\nI'll follow it in our chats now and file a fix for everyone that you review first.`,
        },
        label: { start: () => "Filing a fix" },
        async execute(input, toolCtx) {
          const ownerId = fixOwner(requireStudentId(toolCtx.session.auth));
          if (!ownerId) return { filed: false, reason: "Only Polya's owner can file fixes." };
          const lesson = cleanText(input.lesson, FIX_LIMITS.maxLessonChars);
          if (!lesson) return { filed: false, reason: "The lesson was empty or too long. Write it in one or two sentences." };

          const db = serviceDb();
          const active = await loadActiveFixes(db, ownerId);
          if (!active.ok) return { filed: false, reason: "Fixes aren't set up yet, so nothing was filed." };
          if (activeLessons(active.value, new Date()).length >= FIX_LIMITS.maxActive) {
            return {
              filed: false,
              reason: `${FIX_LIMITS.maxActive} fixes are already waiting. Ship or close one first.`,
            };
          }
          const inserted = await insertFix(db, ownerId, lesson);
          if (!inserted.ok) return { filed: false, reason: "Fixes aren't available right now, so nothing was filed." };
          const fixId = inserted.value;

          const { request, context } = buildFixRequest(fixId, {
            lesson,
            whatWasWrong: input.what_was_wrong.trim(),
            whatPolyaDid: input.what_polya_did.trim(),
            replyingTo: input.replying_to?.trim() || undefined,
            where: input.where,
          });
          const result = await callScopeOps("handoff_task", { product: "polya", request, context });
          const issueUrl = result.ok ? issueUrlFromHandoff(result.structured, result.text) : null;
          const issueRef = issueRefFromUrl(issueUrl);
          if (!issueUrl || !issueRef) {
            return {
              fix: fixId,
              lesson_applies_now: true,
              filed: false,
              reason: `The lesson applies in Noel's chats now, but the fix for everyone wasn't filed: ${result.text || "no task came back"}`,
            };
          }
          const attached = await attachIssue(db, ownerId, fixId, issueRef, issueUrl);
          return {
            fix: fixId,
            lesson_applies_now: true,
            filed: true,
            issue_url: issueUrl,
            ...(attached.ok ? {} : { warning: "The fix was filed, but Polya couldn't link it, so its status won't be texted." }),
          };
        },
      });
    },
  },
});
