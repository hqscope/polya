// POST /polya/gradescope/connect with `Authorization: Bearer $POLYA_CONNECT_SECRET`: the
// askpolya.com connect page signs a student in to Gradescope through the agent, or reads the saved
// connection's state. Request and response shapes are in lib/gradescope/connect.ts.
import { defineChannel, POST } from "eve/channels";

import { serviceDb } from "../lib/db.ts";
import { handleGradescopeConnect, signInToGradescope } from "../lib/gradescope/connect.ts";
import { clearGradescopeCache, loadGradescopeConnectionStatus, saveGradescopeConnection } from "../lib/gradescope/store.ts";
import { findLinkByUser } from "../lib/link.ts";
import { formatReconnectedMessage } from "../lib/reconnect.ts";
import { clearReconnectNotices } from "../lib/reconnect-db.ts";
import { handToStudent } from "../lib/run-check-ins.ts";
import { secretKey } from "../lib/secret-box.ts";

const LOG = "[polya gradescope-connect]";

function logError(message: string, details: Record<string, unknown>): void {
  console.error(`${LOG} ${message}`, details);
}

export default defineChannel({
  routes: [
    POST("/polya/gradescope/connect", (request, ctx) =>
      handleGradescopeConnect(request, {
        secret: process.env.POLYA_CONNECT_SECRET,
        checkReady: () => void secretKey(),
        signIn: (req) => signInToGradescope(req),
        save: (userId, input) => saveGradescopeConnection(userId, input),
        status: (userId) => loadGradescopeConnectionStatus(userId),
        async afterConnect(userId) {
          clearGradescopeCache(userId);
          await clearReconnectNotices(userId, ["gradescope"]).catch((error: unknown) =>
            logError("couldn't clear the reconnect notice", { userId, error: describe(error) }),
          );
          // Best effort, after the response: tell the student's thread it worked.
          ctx.waitUntil(
            (async () => {
              const link = await findLinkByUser(serviceDb(), userId);
              if (!link?.thread_id) return;
              await handToStudent(ctx.to, link.thread_id, userId, formatReconnectedMessage("gradescope"), "polya-reconnect");
            })().catch((error: unknown) => logError("couldn't tell the student's thread", { userId, error: describe(error) })),
          );
        },
        logError,
      }),
    ),
  ],
});

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
