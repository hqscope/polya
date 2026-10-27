// POST /polya/fixes/notify with `Authorization: Bearer $POLYA_FIXES_SECRET`: scope-ops posts here
// when a fix Polya filed changes status (scope-ops lib/polya/notify.ts; body shape in
// lib/fixes.ts FixNotice). The route records the PR and its head commit, then hands a
// `[polya fix]` message to the owner's thread, where the agent texts him. Only the owner's fixes
// are ever looked up.
import { defineChannel, POST } from "eve/channels";
import { createUnauthorizedResponse } from "eve/channels/auth";

import { isAuthorizedTrigger } from "../lib/check-ins-trigger.ts";
import { serviceDb } from "../lib/db.ts";
import { FixNotice, MAX_NOTICE_BYTES, planNotice } from "../lib/fixes.ts";
import { loadFixByIssue, updateFix } from "../lib/fixes-db.ts";
import { findLinkByUser } from "../lib/link.ts";
import { handToStudent } from "../lib/run-check-ins.ts";

const LOG = "[polya fixes]";

export default defineChannel({
  routes: [
    POST("/polya/fixes/notify", async (request, ctx) => {
      if (!isAuthorizedTrigger(request.headers.get("authorization"), process.env.POLYA_FIXES_SECRET)) {
        return createUnauthorizedResponse({ challenges: [{ scheme: "Bearer" }] });
      }
      const ownerId = process.env.NOEL_HUB_POLYA_USER_ID?.trim();
      if (!ownerId) return Response.json({ ok: false, error: "no owner" }, { status: 503 });

      const raw = await request.text();
      if (raw.length > MAX_NOTICE_BYTES) return Response.json({ ok: false, error: "too large" }, { status: 413 });
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return Response.json({ ok: false, error: "bad json" }, { status: 400 });
      }
      const notice = FixNotice.safeParse(body);
      if (!notice.success) return Response.json({ ok: false, error: "bad notice" }, { status: 400 });

      const db = serviceDb();
      const found = await loadFixByIssue(db, ownerId, notice.data.issue);
      if (!found.ok) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
      const fix = found.value;
      if (!fix) return Response.json({ ok: false, error: "not a Polya fix" }, { status: 404 });

      const plan = planNotice(fix, notice.data);
      if (plan.kind === "ignore") return Response.json({ ok: true, ignored: plan.reason });
      const updated = await updateFix(db, ownerId, fix.id, plan.update);
      if (!updated.ok) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });

      if (plan.handOff) {
        const message = plan.handOff;
        // Best effort, after the response: scope-ops only waits 5 seconds.
        ctx.waitUntil(
          (async () => {
            const link = await findLinkByUser(db, ownerId);
            if (!link?.thread_id) return;
            await handToStudent(ctx.to, link.thread_id, ownerId, message, "polya-fixes");
          })().catch((error: unknown) =>
            console.error(`${LOG} couldn't tell the owner's thread`, { fix: fix.id, error: error instanceof Error ? error.message : String(error) }),
          ),
        );
      }
      return Response.json({ ok: true, fix: fix.id, status: plan.update.status }, { status: 202 });
    }),
  ],
});
