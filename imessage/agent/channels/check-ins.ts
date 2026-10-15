// Manual or backup trigger for the check-in loop: POST /polya/check-ins/run with
// `Authorization: Bearer $POLYA_CHECKINS_SECRET`. The eve schedule (schedules/check-ins.ts) is the
// primary trigger; this runs the same idempotent loop, so overlapping with it is safe.
import { defineChannel, POST } from "eve/channels";
import { createUnauthorizedResponse } from "eve/channels/auth";

import { isAuthorizedTrigger } from "../lib/check-ins-trigger.ts";
import { runCheckIns } from "../lib/run-check-ins.ts";

export default defineChannel({
  routes: [
    POST("/polya/check-ins/run", async (request, ctx) => {
      if (!isAuthorizedTrigger(request.headers.get("authorization"), process.env.POLYA_CHECKINS_SECRET)) {
        return createUnauthorizedResponse({ challenges: [{ scheme: "Bearer" }] });
      }
      // The run can outlast a caller's timeout, so answer now and keep working in the background.
      // Counts land in the logs.
      ctx.waitUntil(
        runCheckIns(ctx.to, new Date()).then(
          (counts) => console.log("[polya check-ins] triggered run", counts),
          (error: unknown) => console.error("[polya check-ins] triggered run failed", error),
        ),
      );
      return Response.json({ ok: true, status: "started" }, { status: 202 });
    }),
  ],
});
