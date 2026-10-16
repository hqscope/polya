// The check-in loop as one call, shared by the eve schedule (schedules/check-ins.ts) and the
// manual trigger route (channels/check-ins.ts). Each check-in is handed to the student's iMessage
// thread, where the agent writes the actual text (instructions/check-ins.md). After the check-ins,
// the same run texts students whose Gradescope or Canvas connection stopped working (reconnect.ts).
import type { SessionAuthContext } from "eve/context";
import type { ScheduleToFn } from "eve/schedules";

import photon from "../channels/photon.ts";
import { claimCheckIn, loadCheckInLinks, releaseCheckIns } from "./check-ins-db.ts";
import { processCheckIns, type CheckInRunCounts } from "./check-ins-runner.ts";
import { appUrl } from "./link.ts";
import { processReconnectNotices, type ReconnectRunCounts } from "./reconnect.ts";
import {
  claimReconnectNotice,
  clearReconnectNotices,
  confirmReconnectNeeded,
  loadReconnectHealth,
  loadReconnectNotices,
} from "./reconnect-db.ts";
import { loadStudentReminderData } from "./reminders-db.ts";
import { STUDENT_ATTRIBUTE } from "./student.ts";

export type { CheckInRunCounts } from "./check-ins-runner.ts";

export interface LoopRunCounts extends CheckInRunCounts {
  /** The reconnect pass, or null when it failed as a whole (the check-ins still ran). */
  reconnect: ReconnectRunCounts | null;
}

/** Who a loop-started turn runs as. */
export type LoopPrincipal = "polya-check-ins" | "polya-reconnect";

/**
 * The principal a loop-started turn runs as: the loop itself, carrying the student's Polya user id
 * (looked up server-side from the link row) so the agent's tools work in that session.
 */
export function checkInAuth(userId: string, principal: LoopPrincipal = "polya-check-ins"): SessionAuthContext {
  return {
    authenticator: principal,
    principalType: "service",
    principalId: principal,
    attributes: { [STUDENT_ATTRIBUTE]: userId },
  };
}

/**
 * Hands a message to the student's iMessage thread, where the agent writes the text. `to` is the
 * schedule's `to` or a route's `ctx.to`; both are eve's cross-channel hand-off.
 */
export async function handToStudent(
  to: ScheduleToFn,
  threadId: string,
  userId: string,
  message: string,
  principal: LoopPrincipal,
): Promise<void> {
  // "queue": if the student is mid-conversation, the message waits for that reply to finish
  // instead of interrupting it.
  await to(photon, { adapterName: "imessage", threadId }).send(message, {
    auth: checkInAuth(userId, principal),
    turnPolicy: "queue",
  });
}

export async function runCheckIns(to: ScheduleToFn, now: Date): Promise<LoopRunCounts> {
  const checkIns = await processCheckIns(
    {
      loadLinks: loadCheckInLinks,
      // Canvas + Gradescope, minus submitted, done and snoozed assignments (reminders-db.ts).
      loadStudent: loadStudentReminderData,
      claim: claimCheckIn,
      release: releaseCheckIns,
      send: (threadId, userId, message) => handToStudent(to, threadId, userId, message, "polya-check-ins"),
      logError(message, details) {
        console.error(`[polya check-ins] ${message}`, details);
      },
    },
    now,
  );

  // After the check-ins, so each Gradescope read is a hit on the 10-minute cache they just filled.
  const reconnect = await processReconnectNotices(
    {
      loadLinks: loadCheckInLinks,
      loadNotices: loadReconnectNotices,
      checkHealth: loadReconnectHealth,
      confirmBroken: confirmReconnectNeeded,
      claim: claimReconnectNotice,
      clear: clearReconnectNotices,
      send: (threadId, userId, message) => handToStudent(to, threadId, userId, message, "polya-reconnect"),
      logError(message, details) {
        console.error(`[polya reconnect] ${message}`, details);
      },
    },
    now,
    appUrl(),
  ).catch((error: unknown) => {
    console.error("[polya reconnect] run failed", error instanceof Error ? error.message : error);
    return null;
  });

  return { ...checkIns, reconnect };
}
