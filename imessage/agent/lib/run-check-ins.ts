// The check-in loop as one call, shared by the eve schedule (schedules/check-ins.ts) and the
// manual trigger route (channels/check-ins.ts). Each check-in is handed to the student's iMessage
// thread, where the agent writes the actual text (instructions/check-ins.md).
import type { SessionAuthContext } from "eve/context";
import type { ScheduleToFn } from "eve/schedules";

import photon from "../channels/photon.ts";
import { claimCheckIn, loadCheckInLinks, loadStudentCheckInData, releaseCheckIns } from "./check-ins-db.ts";
import { processCheckIns, type CheckInRunCounts } from "./check-ins-runner.ts";
import { STUDENT_ATTRIBUTE } from "./student.ts";

export type { CheckInRunCounts } from "./check-ins-runner.ts";

/**
 * The principal a check-in turn runs as: the loop itself, carrying the student's Polya user id
 * (looked up server-side from the link row) so the agent's tools work in that session.
 */
export function checkInAuth(userId: string): SessionAuthContext {
  return {
    authenticator: "polya-check-ins",
    principalType: "service",
    principalId: "polya-check-ins",
    attributes: { [STUDENT_ATTRIBUTE]: userId },
  };
}

/** `to` is the schedule's `to` or a route's `ctx.to`; both are eve's cross-channel hand-off. */
export function runCheckIns(to: ScheduleToFn, now: Date): Promise<CheckInRunCounts> {
  return processCheckIns(
    {
      loadLinks: loadCheckInLinks,
      loadStudent: loadStudentCheckInData,
      claim: claimCheckIn,
      release: releaseCheckIns,
      async send(threadId, userId, message) {
        // "queue": if the student is mid-conversation, the check-in waits for that reply to
        // finish instead of interrupting it.
        await to(photon, { adapterName: "imessage", threadId }).send(message, {
          auth: checkInAuth(userId),
          turnPolicy: "queue",
        });
      },
      logError(message, details) {
        console.error(`[polya check-ins] ${message}`, details);
      },
    },
    now,
  );
}
